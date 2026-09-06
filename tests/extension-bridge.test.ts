import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import express from "express";
import { startExtensionBridge, type ExtensionBridge } from "../src/extension/bridge.js";
import { EXTENSION_BRIDGE_PORT } from "../src/config/paths.js";
import { formatTaskBlock, parseTaskBlock } from "../src/extension/task-block.js";
import { computeApprovalSummaryHash } from "../src/inbox/approval.js";
import { TaskInbox } from "../src/inbox/task-inbox.js";
import { Workspace } from "../src/workspace/manager.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, cleanup } from "./helpers.js";

describe("localhost extension bridge", () => {
  let root: string;
  let testPort = 0;
  const realListen = express.application.listen;
  let listener: ReturnType<typeof vi.spyOn>;
  let bridge: ExtensionBridge | undefined;
  const approved = {
    taskSummary: "Repair the local task handoff",
    instruction: "Forward the approved instruction to the local Codex invoker.",
  };

  beforeEach(() => {
    // Exercise real HTTP middleware without binding or stopping the user's service.
    // The production listener must still request its fixed port. Only the test
    // transport maps that request to an OS-assigned private test port.
    testPort = 0;
    listener = vi.spyOn(express.application, "listen").mockImplementation(function (this: express.Application, ...args: unknown[]) {
      expect(args[0]).toBe(EXTENSION_BRIDGE_PORT);
      return Reflect.apply(realListen, this, [testPort, ...args.slice(1)]);
    });
    isolateStateDir();
    root = makeTmpDir("extension-ws");
    makeGitRepo(root);
  });

  afterEach(async () => {
    await bridge?.close();
    cleanup(root);
    bridge = undefined;
    listener.mockRestore();
  });

  async function armedBlock(): Promise<{ block: string; workspaceId: string }> {
    const workspace = new Workspace(root);
    new TaskInbox(workspace.id).arm({
      taskId: "c2c_task_a",
      workspaceId: workspace.id,
      operation: "codex_turn",
      armId: "arm_a",
      idempotencyKey: "idem_a",
      ...approved,
    });
    return {
      workspaceId: workspace.id,
      block: formatTaskBlock({
        taskId: "c2c_task_a",
        workspaceId: workspace.id,
        operation: "codex_turn",
        attempt: 1,
        armId: "arm_a",
        idempotencyKey: "idem_a",
        ...approved,
        approvalSummaryHash: computeApprovalSummaryHash(approved.taskSummary, approved.instruction),
      }),
    };
  }

  it("dispatches one already-armed task and returns only structured metadata", async () => {
    const { block, workspaceId } = await armedBlock();
    let calls = 0;
    bridge = await startExtensionBridge({
      workspaceRoot: root,
      persistRuntime: false,
      invoke: () => {
        calls++;
        return { exitStatus: "ok", tests: "3 passed", changedFiles: ["src/index.ts"] };
      },
    });

    const pair = await fetch(`${bridge.localBaseUrl()}/v1/task/pair`, {
      method: "POST",
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
        "x-c2c-extension-id": "abcdefghijklmnop",
        "x-c2c-user-activation": "1",
        connection: "close",
      },
    });
    const pairBody = (await pair.json()) as { nonce?: unknown };
    expect(pair.status).toBe(200);
    expect(typeof pairBody.nonce).toBe("string");

    const response = await fetch(`${bridge.localBaseUrl()}/v1/task/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(pairBody.nonce)}`,
        origin: "chrome-extension://abcdefghijklmnop",
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({ block }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ ok: true, workspaceId, taskId: "c2c_task_a", status: "SUCCEEDED", tests: "3 passed" }));
    expect(body).not.toHaveProperty("stdout");
    expect(body).not.toHaveProperty("prompt");
    expect(calls).toBe(1);
  });

  it("consumes the nonce once and rejects web origins before dispatch", async () => {
    const { block } = await armedBlock();
    bridge = await startExtensionBridge({ workspaceRoot: root, persistRuntime: false, invoke: () => ({ exitStatus: "ok" }) });
    const headers = {
      authorization: `Bearer ${bridge.nonce}`,
      origin: "https://chatgpt.com",
      "content-type": "application/json",
      connection: "close",
    };
    const denied = await fetch(`${bridge.localBaseUrl()}/v1/task/dispatch`, { method: "POST", headers, body: JSON.stringify({ block }) });
    expect(denied.status).toBe(403);
    const accepted = await fetch(`${bridge.localBaseUrl()}/v1/task/dispatch`, {
      method: "POST",
      headers: { ...headers, origin: "chrome-extension://abcdefghijklmnop" },
      body: JSON.stringify({ block }),
    });
    expect(accepted.status).toBe(200);
    const replay = await fetch(`${bridge.localBaseUrl()}/v1/task/dispatch`, {
      method: "POST",
      headers: { ...headers, origin: "chrome-extension://abcdefghijklmnop" },
      body: JSON.stringify({ block }),
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("NONCE_REPLAYED");
  });

  it("rejects a browser block whose approved instruction differs from the local arm", async () => {
    const { block } = await armedBlock();
    const original = parseTaskBlock(block);
    const tamperedInstruction = "Inspect only the local task state.";
    const tampered = formatTaskBlock({
      ...original,
      instruction: tamperedInstruction,
      approvalSummaryHash: computeApprovalSummaryHash(original.taskSummary, tamperedInstruction),
    });
    let calls = 0;
    bridge = await startExtensionBridge({
      workspaceRoot: root,
      persistRuntime: false,
      invoke: () => {
        calls++;
        return { exitStatus: "ok" };
      },
    });

    const response = await fetch(`${bridge.localBaseUrl()}/v1/task/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.nonce}`,
        origin: "chrome-extension://abcdefghijklmnop",
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({ block: tampered }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("APPROVAL_MISMATCH");
    expect(calls).toBe(0);
  });

  it("never arms from the browser and rejects wrong workspace or malformed blocks", async () => {
    const { block, workspaceId } = await armedBlock();
    let calls = 0;
    bridge = await startExtensionBridge({ workspaceRoot: root, persistRuntime: false, invoke: () => { calls++; return { exitStatus: "ok" }; } });
    const request = (candidate: string) => fetch(`${bridge!.localBaseUrl()}/v1/task/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge!.nonce}`,
        origin: "chrome-extension://abcdefghijklmnop",
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({ block: candidate }),
    });
    const malformed = await request(block.replace(`WORKSPACE_ID: ${workspaceId}`, "WORKSPACE_ID: other_workspace"));
    expect(malformed.status).toBe(403);
    expect((await malformed.json()).error).toBe("WORKSPACE_MISMATCH");
    expect(calls).toBe(0);
  });

  it("requires extension-origin activation and rejects a second automatic pairing", async () => {
    bridge = await startExtensionBridge({ workspaceRoot: root, persistRuntime: false, invoke: () => ({ exitStatus: "ok" }) });
    const base = `${bridge.localBaseUrl()}/v1/task/pair`;
    const missingActivation = await fetch(base, {
      method: "POST",
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
        "x-c2c-extension-id": "abcdefghijklmnop",
        connection: "close",
      },
    });
    expect(missingActivation.status).toBe(403);
    expect((await missingActivation.json()).error).toBe("USER_ACTIVATION_REQUIRED");

    const mismatchedId = await fetch(base, {
      method: "POST",
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
        "x-c2c-extension-id": "differentextension",
        "x-c2c-user-activation": "1",
        connection: "close",
      },
    });
    expect(mismatchedId.status).toBe(403);
    expect((await mismatchedId.json()).error).toBe("EXTENSION_ID_MISMATCH");

    const paired = await fetch(base, {
      method: "POST",
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
        "x-c2c-extension-id": "abcdefghijklmnop",
        "x-c2c-user-activation": "1",
        connection: "close",
      },
    });
    expect(paired.status).toBe(200);
    const replay = await fetch(base, {
      method: "POST",
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
        "x-c2c-extension-id": "abcdefghijklmnop",
        "x-c2c-user-activation": "1",
        connection: "close",
      },
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("PAIRING_CONSUMED");
  });

  it("uses the fixed port and fails closed when it is occupied", async () => {
    expect(EXTENSION_BRIDGE_PORT).toBe(62141);
    await expect(startExtensionBridge({ workspaceRoot: root, port: 0, persistRuntime: false })).rejects.toThrow("EXTENSION_PORT_FIXED:62141");

    const occupied = createServer((_req, res) => res.end());
    await new Promise<void>((resolve, reject) => {
      occupied.once("listening", () => resolve());
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1");
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("test port unavailable");
    testPort = address.port;
    try {
      await expect(startExtensionBridge({ workspaceRoot: root, persistRuntime: false })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });
});
