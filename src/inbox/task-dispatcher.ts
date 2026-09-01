import { randomUUID } from "node:crypto";
import { appendExecutionRecord } from "../execution/records.js";
import {
  readDispatchReceipt,
  readResultReceipt,
  writeDispatchReceipt,
  writeResultReceipt,
  type ResultReceipt,
} from "./receipts.js";
import {
  TaskInbox,
  TaskInboxError,
  type TaskEnvelope,
  type TaskOperation,
} from "./task-inbox.js";

export type CodexTurnRequest = {
  taskId: string;
  workspaceId: string;
  operation: TaskOperation;
  armId: string;
  attempt: 1;
  idempotencyKey: string;
  dispatchId: string;
  taskSummary: string;
  instruction: string;
  approvalSummaryHash: string;
};

export type CodexTurnOutcome = {
  exitStatus: "ok" | "failed" | "blocked";
  tests?: string | null;
  changedFiles?: string[] | number;
  notes?: string;
};

export type CodexTurnInvoker = (request: CodexTurnRequest) => CodexTurnOutcome | Promise<CodexTurnOutcome>;

export type DispatchRequest = {
  taskId: string;
  workspaceId?: string;
  attempt?: number;
  idempotencyKey?: string;
};

export type DispatchResult = {
  task: TaskEnvelope;
  dispatchReceipt: ReturnType<typeof writeDispatchReceipt>;
  resultReceipt: ResultReceipt;
};

type DispatcherOptions = {
  workspaceId: string;
  inbox?: TaskInbox;
  invoke?: CodexTurnInvoker;
  now?: () => string;
};

const MAX_TEXT = 1_000;
const SAFE_TEXT = /(?:https?:\/\/|file:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,})/i;

function sanitizeText(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || SAFE_TEXT.test(value)) {
    throw new Error(`${field} contains unsafe material`);
  }
  return value;
}

function normalizeChangedFiles(value: string[] | number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 100_000) throw new Error("changedFiles is invalid");
    return value;
  }
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("changedFiles is invalid");
  for (const file of value) {
    if (typeof file !== "string" || file.length > 1_000 || /[\u0000-\u001f\u007f]/.test(file) || SAFE_TEXT.test(file)) {
      throw new Error("changedFiles contains unsafe material");
    }
  }
  return value.length;
}

function terminalStatus(exitStatus: CodexTurnOutcome["exitStatus"]): ResultReceipt["status"] {
  if (exitStatus === "ok") return "SUCCEEDED";
  if (exitStatus === "failed") return "FAILED";
  return "BLOCKED";
}

function asSafeOutcome(value: CodexTurnOutcome): Required<Pick<CodexTurnOutcome, "exitStatus">> & {
  tests: string | null;
  changedFilesCount: number;
  notes?: string;
} {
  if (!value || !["ok", "failed", "blocked"].includes(value.exitStatus)) throw new Error("invalid invoker result");
  const tests = sanitizeText(value.tests, "tests");
  const changedFilesCount = normalizeChangedFiles(value.changedFiles);
  const notes = value.notes === undefined ? undefined : sanitizeText(value.notes, "notes") ?? undefined;
  return { exitStatus: value.exitStatus, tests, changedFilesCount, ...(notes ? { notes } : {}) };
}

async function defaultInvoker(_request: CodexTurnRequest): Promise<CodexTurnOutcome> {
  // No shell, browser, network, or generic runner is available through this seam.
  return { exitStatus: "blocked", notes: "NO_INVOKER" };
}

export class TaskDispatcher {
  readonly workspaceId: string;
  readonly inbox: TaskInbox;
  private readonly invoke: CodexTurnInvoker;
  private readonly now: () => string;

  constructor(options: DispatcherOptions) {
    this.workspaceId = options.workspaceId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.inbox = options.inbox ?? new TaskInbox(options.workspaceId, { now: this.now });
    if (this.inbox.workspaceId !== options.workspaceId) {
      throw new TaskInboxError("WORKSPACE_MISMATCH", `inbox is bound to ${this.inbox.workspaceId}`);
    }
    this.invoke = options.invoke ?? defaultInvoker;
  }

  async dispatch(request: string | DispatchRequest): Promise<DispatchResult> {
    const normalized: DispatchRequest = typeof request === "string" ? { taskId: request } : request;
    if (normalized.workspaceId !== undefined && normalized.workspaceId !== this.workspaceId) {
      throw new TaskInboxError("WORKSPACE_MISMATCH", `expected ${this.workspaceId}`);
    }
    const task = this.inbox.load(normalized.taskId);
    if (normalized.attempt !== undefined && normalized.attempt !== task.attempt) {
      throw new TaskInboxError("ATTEMPT_MISMATCH", `expected attempt ${task.attempt}`);
    }
    if (normalized.idempotencyKey !== undefined && normalized.idempotencyKey !== task.idempotencyKey) {
      throw new TaskInboxError("TASK_REPLAYED", "idempotency key mismatch");
    }
    const dispatchId = randomUUID();
    const claimed = this.inbox.claim(task.taskId, {
      workspaceId: this.workspaceId,
      attempt: normalized.attempt ?? task.attempt,
      idempotencyKey: normalized.idempotencyKey ?? task.idempotencyKey,
      dispatchId,
    });
    if (claimed.operation !== "codex_turn") {
      throw new TaskInboxError("OPERATION_NOT_ALLOWED", `operation '${claimed.operation}' is not approved`);
    }
    const dispatchReceipt = writeDispatchReceipt({
      schemaVersion: 1,
      authority: "local-task-inbox",
      kind: "dispatch",
      receiptId: dispatchId,
      taskId: claimed.taskId,
      workspaceId: claimed.workspaceId,
      operation: claimed.operation,
      armId: claimed.armId,
      attempt: claimed.attempt,
      idempotencyKey: claimed.idempotencyKey,
      dispatchId,
      status: "CLAIMED",
      createdAt: this.now(),
    });
    this.inbox.markRunning(claimed.taskId, { workspaceId: this.workspaceId, attempt: claimed.attempt });

    let outcome: CodexTurnOutcome;
    try {
      outcome = await this.invoke({
        taskId: claimed.taskId,
        workspaceId: claimed.workspaceId,
        operation: claimed.operation,
        armId: claimed.armId,
        attempt: claimed.attempt,
        idempotencyKey: claimed.idempotencyKey,
        dispatchId,
        taskSummary: claimed.taskSummary,
        instruction: claimed.instruction,
        approvalSummaryHash: claimed.approvalSummaryHash,
      });
    } catch {
      // Invocation errors are deliberately not copied into a receipt: they may contain
      // provider, browser, command, or credential material. The durable state is terminal.
      outcome = { exitStatus: "blocked", notes: "INVOKER_FAILED" };
    }

    let safe: ReturnType<typeof asSafeOutcome>;
    try {
      safe = asSafeOutcome(outcome);
    } catch {
      safe = { exitStatus: "blocked", tests: null, changedFilesCount: 0, notes: "INVALID_RESULT" };
    }
    const completedAt = this.now();
    const resultReceipt = writeResultReceipt({
      schemaVersion: 1,
      authority: "local-task-inbox",
      kind: "result",
      receiptId: dispatchId,
      taskId: claimed.taskId,
      workspaceId: claimed.workspaceId,
      operation: claimed.operation,
      armId: claimed.armId,
      attempt: claimed.attempt,
      idempotencyKey: claimed.idempotencyKey,
      dispatchId,
      status: terminalStatus(safe.exitStatus),
      exitStatus: safe.exitStatus,
      tests: safe.tests,
      changedFilesCount: safe.changedFilesCount,
      ...(safe.notes ? { notes: safe.notes } : {}),
      createdAt: completedAt,
      completedAt,
    });
    appendExecutionRecord(this.workspaceId, {
      taskId: claimed.taskId,
      iteration: claimed.attempt,
      changedFiles: safe.changedFilesCount,
      tests: safe.tests,
      exitStatus: safe.exitStatus,
      timestamp: completedAt,
      ...(safe.notes ? { notes: safe.notes } : {}),
    });
    const finalTask = this.inbox.complete(claimed.taskId, {
      workspaceId: this.workspaceId,
      attempt: claimed.attempt,
      status: resultReceipt.status,
      resultReceiptId: resultReceipt.receiptId,
    });
    return { task: finalTask, dispatchReceipt, resultReceipt };
  }

  recoverPending(): TaskEnvelope[] {
    return this.inbox.list().filter((task) => task.status === "ARMED" || task.status === "DISPATCHING" || task.status === "RUNNING");
  }

  readResult(taskId: string): ResultReceipt | null {
    return readResultReceipt(this.workspaceId, taskId);
  }

  readDispatch(taskId: string) {
    return readDispatchReceipt(this.workspaceId, taskId);
  }
}
