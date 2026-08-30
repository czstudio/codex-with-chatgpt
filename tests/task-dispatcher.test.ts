import { beforeEach, describe, expect, it } from "vitest";
import { readExecutionRecords } from "../src/execution/records.js";
import { readDispatchReceipt, readResultReceipt } from "../src/inbox/receipts.js";
import { TaskDispatcher } from "../src/inbox/task-dispatcher.js";
import { TaskInbox, TaskInboxError } from "../src/inbox/task-inbox.js";
import { isolateStateDir } from "./helpers.js";

describe("recoverable task dispatcher", () => {
  beforeEach(() => isolateStateDir());

  function arm(): TaskInbox {
    const inbox = new TaskInbox("workspace-a");
    inbox.arm({
      taskId: "task-a",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-a",
      idempotencyKey: "idem-a",
    });
    return inbox;
  }

  it("dispatches one approved local turn and persists a result receipt", async () => {
    arm();
    const calls: unknown[] = [];
    const dispatcher = new TaskDispatcher({
      workspaceId: "workspace-a",
      invoke: async (request) => {
        calls.push(request);
        return { exitStatus: "ok", tests: "3 passed", changedFiles: ["src/index.ts"] };
      },
    });

    const result = await dispatcher.dispatch({ taskId: "task-a", attempt: 1, idempotencyKey: "idem-a" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({
      taskId: "task-a",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-a",
      attempt: 1,
      idempotencyKey: "idem-a",
    }));
    expect(result.task.status).toBe("SUCCEEDED");
    expect(result.resultReceipt.status).toBe("SUCCEEDED");
    expect(readDispatchReceipt("workspace-a", "task-a")?.status).toBe("CLAIMED");
    expect(readResultReceipt("workspace-a", "task-a")?.changedFilesCount).toBe(1);
    expect(readExecutionRecords("workspace-a", 10, "task-a")).toEqual([
      expect.objectContaining({ taskId: "task-a", iteration: 1, changedFiles: 1, tests: "3 passed", exitStatus: "ok" }),
    ]);
  });

  it("rejects replay and wrong fences without invoking again", async () => {
    arm();
    let invocations = 0;
    const dispatcher = new TaskDispatcher({
      workspaceId: "workspace-a",
      invoke: () => {
        invocations++;
        return { exitStatus: "failed", notes: "expected failure" };
      },
    });
    await dispatcher.dispatch("task-a");
    await expect(dispatcher.dispatch({ taskId: "task-a", attempt: 1, idempotencyKey: "idem-a" })).rejects.toThrow(TaskInboxError);
    await expect(dispatcher.dispatch({ taskId: "task-a", attempt: 2, idempotencyKey: "idem-a" })).rejects.toThrow(/ATTEMPT_MISMATCH/);
    await expect(dispatcher.dispatch({ taskId: "task-a", workspaceId: "workspace-b" })).rejects.toThrow(/WORKSPACE_MISMATCH/);
    expect(invocations).toBe(1);
  });

  it("recovers durable pending state after a restart without blind rerun", async () => {
    arm();
    const first = new TaskDispatcher({ workspaceId: "workspace-a" });
    const pending = first.recoverPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("ARMED");

    const secondCalls: unknown[] = [];
    const restarted = new TaskDispatcher({
      workspaceId: "workspace-a",
      invoke: (request) => {
        secondCalls.push(request);
        return { exitStatus: "ok" };
      },
    });
    expect(restarted.recoverPending()).toHaveLength(1);
    expect(secondCalls).toHaveLength(0);
    const result = await restarted.dispatch("task-a");
    expect(result.task.status).toBe("SUCCEEDED");
    expect(secondCalls).toHaveLength(1);
    expect(new TaskDispatcher({ workspaceId: "workspace-a", invoke: () => ({ exitStatus: "ok" }) }).recoverPending()).toHaveLength(0);
  });

  it("fails closed and records no raw invoker error or packet", async () => {
    arm();
    const dispatcher = new TaskDispatcher({
      workspaceId: "workspace-a",
      invoke: () => {
        throw new Error("https://chatgpt.com/c/secret?token=should-not-persist");
      },
    });
    const result = await dispatcher.dispatch("task-a");
    expect(result.task.status).toBe("BLOCKED");
    expect(result.resultReceipt.notes).toBe("INVOKER_FAILED");
    expect(JSON.stringify(result)).not.toMatch(/chatgpt\.com|token=|prompt|browser/i);
  });
});
