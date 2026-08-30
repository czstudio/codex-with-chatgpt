import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";

export const ALLOWED_TASK_OPERATIONS = ["codex_turn"] as const;
export type TaskOperation = (typeof ALLOWED_TASK_OPERATIONS)[number];

export const TASK_STATUSES = [
  "ARMED",
  "DISPATCHING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const SCHEMA_VERSION = 1 as const;
const AUTHORITY = "local-task-inbox" as const;
const MAX_ID_LENGTH = 160;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export type TaskEnvelope = {
  schemaVersion: typeof SCHEMA_VERSION;
  authority: typeof AUTHORITY;
  kind: "task";
  taskId: string;
  workspaceId: string;
  operation: TaskOperation;
  armId: string;
  attempt: 1;
  idempotencyKey: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  dispatchId?: string;
  resultReceiptId?: string;
};

export type ArmTaskInput = {
  taskId: string;
  workspaceId: string;
  operation: string;
  attempt?: number;
  armId?: string;
  idempotencyKey?: string;
};

export type TaskClaimInput = {
  workspaceId: string;
  attempt: number;
  idempotencyKey: string;
  dispatchId: string;
};

export type TaskTransitionInput = {
  workspaceId: string;
  attempt: number;
};

export class TaskInboxError extends Error {
  constructor(
    public readonly code:
      | "WORKSPACE_MISMATCH"
      | "OPERATION_NOT_ALLOWED"
      | "ATTEMPT_INVALID"
      | "ATTEMPT_MISMATCH"
      | "TASK_NOT_ARMED"
      | "TASK_NOT_FOUND"
      | "TASK_ALREADY_EXISTS"
      | "TASK_REPLAYED"
      | "TASK_BUSY"
      | "INBOX_INTEGRITY_FAILURE"
      | "INVALID_TASK_ID"
      | "INVALID_IDEMPOTENCY_KEY",
    message?: string
  ) {
    super(`${code}: ${message ?? code}`);
    this.name = "TaskInboxError";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeId(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || !SAFE_ID.test(value)) {
    throw new TaskInboxError(field === "idempotencyKey" ? "INVALID_IDEMPOTENCY_KEY" : "INVALID_TASK_ID", `${field} is not a safe identifier`);
  }
  return value;
}

function assertWorkspace(expected: string, actual: string): void {
  if (actual !== expected) throw new TaskInboxError("WORKSPACE_MISMATCH", `expected ${expected}`);
}

function assertOperation(operation: string): asserts operation is TaskOperation {
  if (!ALLOWED_TASK_OPERATIONS.includes(operation as TaskOperation)) {
    throw new TaskInboxError("OPERATION_NOT_ALLOWED", `operation '${operation}' is not approved`);
  }
}

function assertAttempt(attempt: number | undefined): asserts attempt is 1 | undefined {
  if (attempt !== undefined && (!Number.isInteger(attempt) || attempt !== 1)) {
    throw new TaskInboxError("ATTEMPT_INVALID", "only attempt 1 may be armed");
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", `${field} is not a valid timestamp`);
  }
}

function validateEnvelope(value: unknown, expectedWorkspaceId: string): TaskEnvelope {
  if (!isRecord(value)) throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", "envelope is not an object");
  const allowed = new Set([
    "schemaVersion",
    "authority",
    "kind",
    "taskId",
    "workspaceId",
    "operation",
    "armId",
    "attempt",
    "idempotencyKey",
    "status",
    "createdAt",
    "updatedAt",
    "dispatchId",
    "resultReceiptId",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", "unknown envelope field");
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.authority !== AUTHORITY || value.kind !== "task") {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", "unknown schema or authority");
  }
  if (typeof value.taskId !== "string" || typeof value.workspaceId !== "string" || typeof value.operation !== "string" ||
      typeof value.armId !== "string" || typeof value.idempotencyKey !== "string") {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", "invalid envelope identifiers");
  }
  try {
    assertSafeId(value.taskId, "taskId");
    assertSafeId(value.armId, "armId");
    assertSafeId(value.idempotencyKey, "idempotencyKey");
  } catch (error) {
    if (error instanceof TaskInboxError) {
      throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", error.message);
    }
    throw error;
  }
  assertWorkspace(expectedWorkspaceId, value.workspaceId);
  assertOperation(value.operation);
  if (value.attempt !== 1 || typeof value.attempt !== "number") {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", "attempt must be 1");
  }
  if (!TASK_STATUSES.includes(value.status as TaskStatus)) {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", "unknown task status");
  }
  assertTimestamp(value.createdAt, "createdAt");
  assertTimestamp(value.updatedAt, "updatedAt");
  for (const field of ["dispatchId", "resultReceiptId"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "string") throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", `${field} is not a string`);
      assertSafeId(value[field], field);
    }
  }
  const status = value.status as TaskStatus;
  if ((status === "DISPATCHING" || status === "RUNNING" || status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED") &&
      typeof value.dispatchId !== "string") {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", `${status} task must have a dispatchId`);
  }
  if ((status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED") && typeof value.resultReceiptId !== "string") {
    throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", `${status} task must have a result receipt`);
  }
  return clone(value) as TaskEnvelope;
}

function safeStatePath(workspaceId: string, taskId: string): string {
  assertSafeId(workspaceId, "workspaceId");
  assertSafeId(taskId, "taskId");
  return path.join(getStateDir(), "inbox", workspaceId, `${taskId}.json`);
}

function atomicWrite(file: string, value: unknown): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // already renamed or absent
    }
  }
}

type LockCallback<T> = () => T;

export class TaskInbox {
  readonly workspaceId: string;
  private readonly dir: string;
  private readonly now: () => string;

  constructor(workspaceId: string, opts: { now?: () => string } = {}) {
    assertSafeId(workspaceId, "workspaceId");
    this.workspaceId = workspaceId;
    this.dir = path.join(getStateDir(), "inbox", workspaceId);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  filePath(taskId: string): string {
    return safeStatePath(this.workspaceId, taskId);
  }

  private lockPath(taskId: string): string {
    return `${this.filePath(taskId)}.lock`;
  }

  private withLock<T>(taskId: string, callback: LockCallback<T>): T {
    const lock = this.lockPath(taskId);
    const dir = path.dirname(lock);
    ensureDir(dir);
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // best effort on platforms without chmod semantics
    }
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new TaskInboxError("TASK_BUSY", "task lock already exists; refusing to reclaim it");
      }
      throw error;
    }
    try {
      return callback();
    } finally {
      try {
        fs.closeSync(fd);
      } finally {
        try {
          fs.unlinkSync(lock);
        } catch {
          // preserve the original operation result/error
        }
      }
    }
  }

  private readFile(taskId: string): TaskEnvelope {
    const file = this.filePath(taskId);
    if (!fs.existsSync(file)) throw new TaskInboxError("TASK_NOT_FOUND", `task '${taskId}' does not exist`);
    try {
      return validateEnvelope(JSON.parse(fs.readFileSync(file, "utf8")), this.workspaceId);
    } catch (error) {
      if (error instanceof TaskInboxError) throw error;
      throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", error instanceof Error ? error.message : "invalid JSON");
    }
  }

  load(taskId: string): TaskEnvelope {
    assertSafeId(taskId, "taskId");
    return clone(this.readFile(taskId));
  }

  list(): TaskEnvelope[] {
    const entries = fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : [];
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => this.load(entry.slice(0, -5)));
  }

  arm(input: ArmTaskInput): TaskEnvelope {
    assertWorkspace(this.workspaceId, input.workspaceId);
    assertSafeId(input.taskId, "taskId");
    assertOperation(input.operation);
    assertAttempt(input.attempt);
    const armId = input.armId ?? randomUUID();
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    assertSafeId(armId, "armId");
    assertSafeId(idempotencyKey, "idempotencyKey");
    const file = this.filePath(input.taskId);

    if (fs.existsSync(file)) {
      const existing = this.readFile(input.taskId);
      const sameArm = existing.workspaceId === input.workspaceId && existing.operation === input.operation &&
        existing.attempt === (input.attempt ?? 1) && existing.armId === armId && existing.idempotencyKey === idempotencyKey;
      if (sameArm && existing.status === "ARMED") return clone(existing);
      if (sameArm) throw new TaskInboxError("TASK_REPLAYED", `task '${input.taskId}' has already transitioned`);
      throw new TaskInboxError("TASK_ALREADY_EXISTS", `task '${input.taskId}' is already armed`);
    }

    return this.withLock(input.taskId, () => {
      if (fs.existsSync(file)) {
        const existing = this.readFile(input.taskId);
        const sameArm = existing.workspaceId === input.workspaceId && existing.operation === input.operation &&
          existing.attempt === (input.attempt ?? 1) && existing.armId === armId && existing.idempotencyKey === idempotencyKey;
        if (sameArm && existing.status === "ARMED") return clone(existing);
        if (sameArm) throw new TaskInboxError("TASK_REPLAYED", `task '${input.taskId}' has already transitioned`);
        throw new TaskInboxError("TASK_ALREADY_EXISTS", `task '${input.taskId}' is already armed`);
      }
      const timestamp = this.now();
      assertTimestamp(timestamp, "now");
      const envelope: TaskEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        authority: AUTHORITY,
        kind: "task",
        taskId: input.taskId,
        workspaceId: this.workspaceId,
        operation: input.operation as TaskOperation,
        armId,
        attempt: 1,
        idempotencyKey,
        status: "ARMED",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      atomicWrite(file, envelope);
      return clone(envelope);
    });
  }

  claim(taskId: string, input: TaskClaimInput): TaskEnvelope {
    assertWorkspace(this.workspaceId, input.workspaceId);
    assertSafeId(taskId, "taskId");
    assertSafeId(input.idempotencyKey, "idempotencyKey");
    assertSafeId(input.dispatchId, "dispatchId");
    if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new TaskInboxError("ATTEMPT_INVALID", "attempt must be positive");
    return this.withLock(taskId, () => {
      const current = this.readFile(taskId);
      if (current.attempt !== input.attempt) throw new TaskInboxError("ATTEMPT_MISMATCH", `expected attempt ${current.attempt}`);
      if (current.idempotencyKey !== input.idempotencyKey) throw new TaskInboxError("TASK_REPLAYED", "idempotency key mismatch");
      if (current.status !== "ARMED") throw new TaskInboxError("TASK_NOT_ARMED", `task is ${current.status}`);
      const next: TaskEnvelope = {
        ...current,
        status: "DISPATCHING",
        dispatchId: input.dispatchId,
        updatedAt: this.now(),
      };
      atomicWrite(this.filePath(taskId), next);
      return clone(next);
    });
  }

  markRunning(taskId: string, input: TaskTransitionInput): TaskEnvelope {
    return this.transition(taskId, input, "RUNNING");
  }

  complete(taskId: string, input: TaskTransitionInput & { status: "SUCCEEDED" | "FAILED" | "BLOCKED"; resultReceiptId: string }): TaskEnvelope {
    assertSafeId(input.resultReceiptId, "resultReceiptId");
    if (!["SUCCEEDED", "FAILED", "BLOCKED"].includes(input.status)) {
      throw new TaskInboxError("INBOX_INTEGRITY_FAILURE", "invalid terminal task status");
    }
    return this.transition(taskId, input, input.status, input.resultReceiptId);
  }

  private transition(taskId: string, input: TaskTransitionInput, status: TaskStatus, resultReceiptId?: string): TaskEnvelope {
    assertWorkspace(this.workspaceId, input.workspaceId);
    assertSafeId(taskId, "taskId");
    if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new TaskInboxError("ATTEMPT_INVALID", "attempt must be positive");
    return this.withLock(taskId, () => {
      const current = this.readFile(taskId);
      if (current.attempt !== input.attempt) throw new TaskInboxError("ATTEMPT_MISMATCH", `expected attempt ${current.attempt}`);
      if (current.status === "CANCELLED" || current.status === "SUCCEEDED" || current.status === "FAILED" || current.status === "BLOCKED") {
        throw new TaskInboxError("TASK_NOT_ARMED", `task is ${current.status}`);
      }
      if (status === "RUNNING" && current.status !== "DISPATCHING") {
        throw new TaskInboxError("TASK_NOT_ARMED", `task is ${current.status}`);
      }
      if (status !== "RUNNING" && current.status !== "RUNNING" && current.status !== "DISPATCHING") {
        throw new TaskInboxError("TASK_NOT_ARMED", `task is ${current.status}`);
      }
      const next: TaskEnvelope = {
        ...current,
        status,
        updatedAt: this.now(),
        ...(resultReceiptId ? { resultReceiptId } : {}),
      };
      atomicWrite(this.filePath(taskId), next);
      return clone(next);
    });
  }

  cancel(taskId: string, input: TaskTransitionInput): TaskEnvelope {
    assertWorkspace(this.workspaceId, input.workspaceId);
    assertSafeId(taskId, "taskId");
    if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new TaskInboxError("ATTEMPT_INVALID", "attempt must be positive");
    return this.withLock(taskId, () => {
      const current = this.readFile(taskId);
      if (current.attempt !== input.attempt) throw new TaskInboxError("ATTEMPT_MISMATCH", `expected attempt ${current.attempt}`);
      if (current.status !== "ARMED") throw new TaskInboxError("TASK_NOT_ARMED", `task is ${current.status}`);
      const next: TaskEnvelope = { ...current, status: "CANCELLED", updatedAt: this.now() };
      atomicWrite(this.filePath(taskId), next);
      return clone(next);
    });
  }
}

export function armTask(input: ArmTaskInput): TaskEnvelope {
  return new TaskInbox(input.workspaceId).arm(input);
}

export function readTask(workspaceId: string, taskId: string): TaskEnvelope {
  return new TaskInbox(workspaceId).load(taskId);
}
