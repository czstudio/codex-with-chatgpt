import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { TaskOperation, TaskStatus } from "./task-inbox.js";

const SCHEMA_VERSION = 1 as const;
const AUTHORITY = "local-task-inbox" as const;
const MAX_TEXT = 1_000;
const MAX_ID_LENGTH = 160;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const FORBIDDEN_TEXT = /(?:https?:\/\/|file:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,})/i;

export type DispatchReceipt = {
  schemaVersion: typeof SCHEMA_VERSION;
  authority: typeof AUTHORITY;
  kind: "dispatch";
  receiptId: string;
  taskId: string;
  workspaceId: string;
  operation: TaskOperation;
  armId: string;
  attempt: 1;
  idempotencyKey: string;
  dispatchId: string;
  status: "CLAIMED";
  createdAt: string;
};

export type ResultReceipt = {
  schemaVersion: typeof SCHEMA_VERSION;
  authority: typeof AUTHORITY;
  kind: "result";
  receiptId: string;
  taskId: string;
  workspaceId: string;
  operation: TaskOperation;
  armId: string;
  attempt: 1;
  idempotencyKey: string;
  dispatchId: string;
  status: Extract<TaskStatus, "SUCCEEDED" | "FAILED" | "BLOCKED">;
  exitStatus: "ok" | "failed" | "blocked";
  tests: string | null;
  changedFilesCount: number;
  notes?: string;
  createdAt: string;
  completedAt: string;
};

export class ReceiptError extends Error {
  constructor(public readonly code: "RECEIPT_INTEGRITY_FAILURE" | "RECEIPT_CONFLICT" | "INVALID_RECEIPT", message: string) {
    super(`${code}: ${message}`);
    this.name = "ReceiptError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || !SAFE_ID.test(value)) {
    throw new ReceiptError("INVALID_RECEIPT", `${field} is not a safe identifier`);
  }
}

function assertText(value: unknown, field: string, optional = false): asserts value is string | undefined | null {
  if (optional && value === undefined) return;
  if (value !== null && typeof value !== "string") throw new ReceiptError("INVALID_RECEIPT", `${field} is not text`);
  if (typeof value === "string" && (value.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || FORBIDDEN_TEXT.test(value))) {
    throw new ReceiptError("INVALID_RECEIPT", `${field} contains unsafe material`);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ReceiptError("INVALID_RECEIPT", `${field} is not a valid timestamp`);
  }
}

function basePath(workspaceId: string): string {
  assertId(workspaceId, "workspaceId");
  const dir = path.join(getStateDir(), "inbox", workspaceId, "receipts");
  if (!fs.existsSync(dir)) return dir;
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
  return dir;
}

export function receiptFilePath(workspaceId: string, taskId: string, kind: "dispatch" | "result"): string {
  assertId(taskId, "taskId");
  return path.join(basePath(workspaceId), `${taskId}.${kind}.json`);
}

function atomicWrite(file: string, value: unknown): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort on platforms without chmod semantics
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

function knownKeys(kind: "dispatch" | "result"): Set<string> {
  return new Set(kind === "dispatch"
    ? ["schemaVersion", "authority", "kind", "receiptId", "taskId", "workspaceId", "operation", "armId", "attempt", "idempotencyKey", "dispatchId", "status", "createdAt"]
    : ["schemaVersion", "authority", "kind", "receiptId", "taskId", "workspaceId", "operation", "armId", "attempt", "idempotencyKey", "dispatchId", "status", "exitStatus", "tests", "changedFilesCount", "notes", "createdAt", "completedAt"]);
}

function validateBase(value: unknown, kind: "dispatch" | "result", expectedWorkspaceId: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "receipt is not an object");
  if (Object.keys(value).some((key) => !knownKeys(kind).has(key))) {
    throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "unknown receipt field");
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.authority !== AUTHORITY || value.kind !== kind) {
    throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "unknown schema or authority");
  }
  for (const field of ["receiptId", "taskId", "workspaceId", "operation", "armId", "idempotencyKey", "dispatchId"] as const) {
    assertId(value[field], field);
  }
  if (value.workspaceId !== expectedWorkspaceId) throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "workspace mismatch");
  if (value.operation !== "codex_turn") throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "operation is not approved");
  if (value.attempt !== 1 || typeof value.attempt !== "number") throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "attempt must be 1");
  assertTimestamp(value.createdAt, "createdAt");
  return value;
}

function validateDispatch(value: unknown, expectedWorkspaceId: string): DispatchReceipt {
  const base = validateBase(value, "dispatch", expectedWorkspaceId);
  if (base.status !== "CLAIMED") throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "invalid dispatch status");
  return clone(base) as DispatchReceipt;
}

function validateResult(value: unknown, expectedWorkspaceId: string): ResultReceipt {
  const base = validateBase(value, "result", expectedWorkspaceId);
  const statusByExitStatus: Record<string, ResultReceipt["status"]> = {
    ok: "SUCCEEDED",
    failed: "FAILED",
    blocked: "BLOCKED",
  };
  if (!Object.prototype.hasOwnProperty.call(base, "tests") ||
      !["SUCCEEDED", "FAILED", "BLOCKED"].includes(String(base.status)) ||
      !Object.prototype.hasOwnProperty.call(statusByExitStatus, String(base.exitStatus)) ||
      statusByExitStatus[String(base.exitStatus)] !== base.status) {
    throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "invalid result status");
  }
  assertText(base.tests, "tests");
  if (typeof base.changedFilesCount !== "number" || !Number.isInteger(base.changedFilesCount) || base.changedFilesCount < 0 || base.changedFilesCount > 100_000) {
    throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", "invalid changedFilesCount");
  }
  assertText(base.notes, "notes", true);
  assertTimestamp(base.completedAt, "completedAt");
  return clone(base) as ResultReceipt;
}

function readReceipt<T>(file: string, validate: (value: unknown) => T): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return validate(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    throw new ReceiptError("RECEIPT_INTEGRITY_FAILURE", error instanceof Error ? error.message : "invalid JSON");
  }
}

function writeReceipt<T extends { receiptId: string }>(file: string, value: T, read: () => T | null): T {
  const existing = read();
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(value)) return clone(existing);
    throw new ReceiptError("RECEIPT_CONFLICT", `receipt already exists: ${value.receiptId}`);
  }
  atomicWrite(file, value);
  return clone(value);
}

export function writeDispatchReceipt(receipt: DispatchReceipt): DispatchReceipt {
  const validated = validateDispatch(receipt, receipt.workspaceId);
  const file = receiptFilePath(receipt.workspaceId, receipt.taskId, "dispatch");
  return writeReceipt(file, validated, () => readDispatchReceipt(receipt.workspaceId, receipt.taskId));
}

export function readDispatchReceipt(workspaceId: string, taskId: string): DispatchReceipt | null {
  const file = receiptFilePath(workspaceId, taskId, "dispatch");
  return readReceipt(file, (value) => validateDispatch(value, workspaceId));
}

export function writeResultReceipt(receipt: ResultReceipt): ResultReceipt {
  const validated = validateResult(receipt, receipt.workspaceId);
  const file = receiptFilePath(receipt.workspaceId, receipt.taskId, "result");
  return writeReceipt(file, validated, () => readResultReceipt(receipt.workspaceId, receipt.taskId));
}

export function readResultReceipt(workspaceId: string, taskId: string): ResultReceipt | null {
  const file = receiptFilePath(workspaceId, taskId, "result");
  return readReceipt(file, (value) => validateResult(value, workspaceId));
}
