import { describe, expect, it } from "vitest";
import { CodexCliInvoker, type CodexProcessRunner } from "../src/inbox/codex-invoker.js";

const request = {
  taskId: "task_a",
  workspaceId: "workspace_a",
  operation: "codex_turn" as const,
  armId: "arm_a",
  attempt: 1 as const,
  idempotencyKey: "idem_a",
  dispatchId: "dispatch_a",
};

describe("fixed Codex CLI invoker", () => {
  it("uses only the fixed executable and argv, with no shell or request prompt", async () => {
    let called: { file: string; args: readonly string[]; options: { cwd: string; shell: false } } | undefined;
    const run: CodexProcessRunner = async (file, args, options) => {
      called = { file, args, options };
      return { exitCode: 0, signal: null, stdout: '{"type":"turn.completed"}\n', stderr: "" };
    };
    const invoker = new CodexCliInvoker({ workspaceRoot: process.cwd(), run });

    const outcome = await invoker.invoke(request);
    expect(outcome).toEqual({ exitStatus: "ok", tests: null, changedFiles: 0, notes: "CODEX_CLI_COMPLETED" });
    expect(called?.file).toBe("codex");
    expect(called?.args).toEqual([
      "exec",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--cd",
      process.cwd(),
      "-",
    ]);
    expect(called?.options.shell).toBe(false);
    expect(called?.args.join(" ")).not.toContain(request.taskId);
    expect(called?.args.join(" ")).not.toContain("arbitrary_shell");
  });

  it("fails closed when the CLI is unavailable or emits a failed turn", async () => {
    const unavailable: CodexProcessRunner = async () => {
      const error = Object.assign(new Error("codex not found"), { code: "ENOENT" });
      throw error;
    };
    await expect(new CodexCliInvoker({ workspaceRoot: process.cwd(), run: unavailable }).invoke(request)).resolves.toEqual({
      exitStatus: "blocked",
      tests: null,
      changedFiles: 0,
      notes: "CODEX_CLI_UNAVAILABLE",
    });

    const failed: CodexProcessRunner = async () => ({
      exitCode: 1,
      signal: null,
      stdout: '{"type":"turn.failed"}\n',
      stderr: "provider details must not be returned",
    });
    await expect(new CodexCliInvoker({ workspaceRoot: process.cwd(), run: failed }).invoke(request)).resolves.toEqual({
      exitStatus: "failed",
      tests: null,
      changedFiles: 0,
      notes: "CODEX_CLI_EXIT_NONZERO",
    });
  });
});
