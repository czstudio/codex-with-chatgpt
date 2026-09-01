import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_TASK_OPERATIONS,
  TaskInbox,
  TaskInboxError,
  armTask,
  readTask,
  type TaskEnvelope,
} from "../src/inbox/task-inbox.js";
import { isolateStateDir } from "./helpers.js";

const approved = {
  taskSummary: "Repair the local task handoff",
  instruction: "Forward the approved instruction to the local Codex invoker.",
};

describe("durable task inbox", () => {
  beforeEach(() => isolateStateDir());

  it("requires an explicit local arm and persists an owner-only envelope", () => {
    const inbox = new TaskInbox("workspace-a");
    const task = inbox.arm({
      taskId: "task-a",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-a",
      idempotencyKey: "idem-a",
      ...approved,
    });

    expect(task.status).toBe("ARMED");
    expect(task.attempt).toBe(1);
    expect(task.operation).toBe("codex_turn");
    expect(inbox.load("task-a")).toEqual(task);
    const file = inbox.filePath("task-a");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(task)).not.toMatch(/chatgpt\.com|https?:\/\//i);
  });

  it("is idempotent for the same arm but refuses conflicting or replayed arms", () => {
    const first = armTask({
      taskId: "task-a",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-a",
      idempotencyKey: "idem-a",
      ...approved,
    });
    expect(
      armTask({
        taskId: "task-a",
        workspaceId: "workspace-a",
        operation: "codex_turn",
        armId: "arm-a",
        idempotencyKey: "idem-a",
        ...approved,
      })
    ).toEqual(first);

    expect(() =>
      armTask({
        taskId: "task-a",
        workspaceId: "workspace-a",
        operation: "codex_turn",
        armId: "arm-other",
        idempotencyKey: "idem-other",
        ...approved,
      })
    ).toThrowError(TaskInboxError);
  });

  it("rejects an untrusted workspace, unsupported operation, and wrong attempt", () => {
    expect(ALLOWED_TASK_OPERATIONS).toEqual(["codex_turn"]);
    const inbox = new TaskInbox("workspace-a");
    expect(() =>
      inbox.arm({
        taskId: "task-a",
        workspaceId: "workspace-b",
        operation: "codex_turn",
        armId: "arm-a",
        idempotencyKey: "idem-a",
        ...approved,
      })
    ).toThrow(/WORKSPACE_MISMATCH/);
    expect(() =>
      inbox.arm({
        taskId: "task-b",
        workspaceId: "workspace-a",
        operation: "arbitrary_shell" as never,
        armId: "arm-b",
        idempotencyKey: "idem-b",
        ...approved,
      })
    ).toThrow(/OPERATION_NOT_ALLOWED/);
    expect(() =>
      inbox.arm({
        taskId: "task-c",
        workspaceId: "workspace-a",
        operation: "codex_turn",
        attempt: 2,
        armId: "arm-c",
        idempotencyKey: "idem-c",
        ...approved,
      })
    ).toThrow(/ATTEMPT_INVALID/);
  });

  it("fails closed when the approved summary or instruction is missing or unsafe", () => {
    const inbox = new TaskInbox("workspace-a");
    expect(() => inbox.arm({
      taskId: "task-missing",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-missing",
      idempotencyKey: "idem-missing",
      taskSummary: "",
      instruction: approved.instruction,
    })).toThrow(/APPROVAL_INVALID/);
    expect(() => inbox.arm({
      taskId: "task-dangerous",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-dangerous",
      idempotencyKey: "idem-dangerous",
      taskSummary: approved.taskSummary,
      instruction: "rm -rf workspace",
    })).toThrow(/APPROVAL_INVALID/);
    expect(() => inbox.arm({
      taskId: "task-hash-mismatch",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-hash-mismatch",
      idempotencyKey: "idem-hash-mismatch",
      ...approved,
      approvalSummaryHash: "0".repeat(64),
    })).toThrow(/APPROVAL_INVALID/);
  });

  it("does not allow a stale attempt to transition a durable task", () => {
    const inbox = new TaskInbox("workspace-a");
    inbox.arm({
      taskId: "task-a",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-a",
      idempotencyKey: "idem-a",
      ...approved,
    });
    expect(() =>
      inbox.claim("task-a", {
        workspaceId: "workspace-a",
        attempt: 2,
        idempotencyKey: "idem-a",
        dispatchId: "dispatch-a",
      })
    ).toThrow(/ATTEMPT_MISMATCH/);
    expect(inbox.load("task-a").status).toBe("ARMED");
  });

  it("cancels only an armed task and fails closed on missing or corrupt state", () => {
    const inbox = new TaskInbox("workspace-a");
    inbox.arm({
      taskId: "task-a",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-a",
      idempotencyKey: "idem-a",
      ...approved,
    });
    expect(inbox.cancel("task-a", { workspaceId: "workspace-a", attempt: 1 }).status).toBe("CANCELLED");
    expect(() => inbox.claim("task-a", {
      workspaceId: "workspace-a",
      attempt: 1,
      idempotencyKey: "idem-a",
      dispatchId: "dispatch-a",
    })).toThrow(/TASK_NOT_ARMED/);
    expect(() => readTask("workspace-a", "missing-task")).toThrow(/TASK_NOT_FOUND/);

    const file = inbox.filePath("task-a");
    fs.writeFileSync(file, "{not-json\n");
    expect(() => inbox.load("task-a")).toThrow(/INBOX_INTEGRITY_FAILURE/);
    expect(path.basename(file)).toBe("task-a.json");
  });

  it("does not expose mutable records through a returned object", () => {
    const inbox = new TaskInbox("workspace-a");
    const task = inbox.arm({
      taskId: "task-a",
      workspaceId: "workspace-a",
      operation: "codex_turn",
      armId: "arm-a",
      idempotencyKey: "idem-a",
      ...approved,
    });
    (task as TaskEnvelope).status = "SUCCEEDED";
    expect(inbox.load("task-a").status).toBe("ARMED");
  });
});
