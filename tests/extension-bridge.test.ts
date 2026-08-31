import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startExtensionBridge, type ExtensionBridge } from "../src/extension/bridge.js";
import { formatTaskBlock } from "../src/extension/task-block.js";
import { TaskInbox } from "../src/inbox/task-inbox.js";
import { Workspace } from "../src/workspace/manager.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, cleanup } from "./helpers.js";

describe("localhost extension bridge", () => {
  let root: string;
  let bridge: ExtensionBridge | undefined;

  beforeEach(() => {
    isolateStateDir();
    root = makeTmpDir("extension-ws");
    makeGitRepo(root);
  });

  afterEach(async () => {
    await bridge?.close();
    cleanup(root);
    bridge = undefined;
  });

  async function armedBlock(): Promise<{ block: string; workspaceId: string }> {
    const workspace = new Workspace(root);
    new TaskInbox(workspace.id).arm({
      taskId: "c2c_task_a",
      workspaceId: workspace.id,
      operation: "codex_turn",
      armId: "arm_a",
      idempotencyKey: "idem_a",
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
      }),
    };
  }

  it("dispatches one already-armed task and returns only structured metadata", async () => {
    const { block, workspaceId } = await armedBlock();
    let calls = 0;
    bridge = await startExtensionBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      invoke: () => {
        calls++;
        return { exitStatus: "ok", tests: "3 passed", changedFiles: ["src/index.ts"] };
      },
    });

    const response = await fetch(`${bridge.localBaseUrl()}/v1/task/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.nonce}`,
        origin: "chrome-extension://abcdefghijklmnop",
        "content-type": "application/json",
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
    bridge = await startExtensionBridge({ workspaceRoot: root, port: 0, persistRuntime: false, invoke: () => ({ exitStatus: "ok" }) });
    const headers = {
      authorization: `Bearer ${bridge.nonce}`,
      origin: "https://chatgpt.com",
      "content-type": "application/json",
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

  it("never arms from the browser and rejects wrong workspace or malformed blocks", async () => {
    const { block, workspaceId } = await armedBlock();
    let calls = 0;
    bridge = await startExtensionBridge({ workspaceRoot: root, port: 0, persistRuntime: false, invoke: () => { calls++; return { exitStatus: "ok" }; } });
    const request = (candidate: string) => fetch(`${bridge!.localBaseUrl()}/v1/task/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge!.nonce}`,
        origin: "chrome-extension://abcdefghijklmnop",
        "content-type": "application/json",
      },
      body: JSON.stringify({ block: candidate }),
    });
    const malformed = await request(block.replace(`WORKSPACE_ID: ${workspaceId}`, "WORKSPACE_ID: other_workspace"));
    expect(malformed.status).toBe(403);
    expect((await malformed.json()).error).toBe("WORKSPACE_MISMATCH");
    expect(calls).toBe(0);
  });
});
