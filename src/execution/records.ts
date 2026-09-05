import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

const MAX_TEXT = 2_000;
const MAX_ITEMS = 50;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_LINES = 5_000;
const SCHEMA_VERSION = 1;
const AUDIT_AUTHORITY = "local-audit-hint-only" as const;

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  schemaVersion?: 1;
  authority?: typeof AUDIT_AUTHORITY;
  kind?: "execution";
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  timestamp: string;
  notes?: string;
  baseSha?: string;
  headSha?: string;
  evidence?: string[];
}

export interface CheckpointRecord {
  schemaVersion?: 1;
  authority?: typeof AUDIT_AUTHORITY;
  kind: "checkpoint";
  taskId: string;
  iteration: number;
  state: string;
  summary: string;
  knownIssues: string[];
  nextExpectedStep: string;
  timestamp: string;
}

export type AuditRecord = ExecutionRecord | CheckpointRecord;

export interface AuditIntegrity {
  ok: boolean;
  totalLines: number;
  corruptLines: number[];
  errors: string[];
  bounded: boolean;
}

export interface AuditLog {
  records: AuditRecord[];
  integrity: AuditIntegrity;
}

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

function boundedText(value: string, field: string): string {
  if (value.length > MAX_TEXT) throw new Error(`${field} exceeds ${MAX_TEXT} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} contains control characters`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,}/i.test(value)) {
    throw new Error(`${field} contains credential-like material`);
  }
  return value;
}

function boundedItems(values: string[], field: string): string[] {
  if (values.length > MAX_ITEMS) throw new Error(`${field} exceeds ${MAX_ITEMS} items`);
  return values.map((value) => boundedText(value, field));
}

function normalizeRecord(record: AuditRecord): AuditRecord {
  if (typeof record.taskId !== "string" || !record.taskId || !Number.isInteger(record.iteration) || record.iteration < 0) {
    throw new Error("taskId and a non-negative integer iteration are required");
  }
  if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) {
    throw new Error("a valid timestamp is required");
  }
  if (record.kind === "checkpoint") {
    if (typeof record.state !== "string" || typeof record.summary !== "string" ||
        !Array.isArray(record.knownIssues) || typeof record.nextExpectedStep !== "string") {
      throw new Error("invalid checkpoint shape");
    }
    return {
      ...record,
      schemaVersion: SCHEMA_VERSION,
      authority: AUDIT_AUTHORITY,
      state: boundedText(record.state, "state"),
      summary: boundedText(record.summary, "summary"),
      knownIssues: boundedItems(record.knownIssues, "knownIssues"),
      nextExpectedStep: boundedText(record.nextExpectedStep, "nextExpectedStep"),
    };
  }
  if (record.kind !== undefined && record.kind !== "execution") throw new Error("unknown record kind");
  if (!(Array.isArray(record.changedFiles) || Number.isInteger(record.changedFiles)) ||
      !(record.tests === null || typeof record.tests === "string") || typeof record.exitStatus !== "string") {
    throw new Error("invalid execution shape");
  }
  return {
    ...record,
    schemaVersion: SCHEMA_VERSION,
    authority: AUDIT_AUTHORITY,
    kind: "execution",
    tests: record.tests === null ? null : boundedText(record.tests, "tests"),
    notes: record.notes === undefined ? undefined : boundedText(record.notes, "notes"),
    evidence: record.evidence === undefined ? undefined : boundedItems(record.evidence, "evidence"),
    changedFiles: Array.isArray(record.changedFiles)
      ? boundedItems(record.changedFiles, "changedFiles")
      : record.changedFiles,
  };
}

function recordIdentity(record: AuditRecord): string {
  return record.kind === "checkpoint"
    ? `${record.taskId}:checkpoint:${record.iteration}:${record.state}`
    : `${record.taskId}:execution:${record.iteration}`;
}

function comparable(record: AuditRecord): string {
  const { timestamp: _timestamp, ...stable } = record;
  return JSON.stringify(stable);
}

export function appendAuditRecord(workspaceId: string, record: AuditRecord): void {
  const file = recordsFile(workspaceId);
  const normalized = normalizeRecord(record);
  const existing = readAuditLog(workspaceId);
  if (!existing.integrity.ok) throw new Error(`audit log integrity failure: ${existing.integrity.errors.join("; ")}`);
  const same = existing.records.find((item) => recordIdentity(item) === recordIdentity(normalized));
  if (same) {
    if (comparable(same) === comparable(normalized)) return;
    throw new Error(`conflicting audit record: ${recordIdentity(normalized)}`);
  }
  fs.appendFileSync(file, JSON.stringify(normalized) + "\n", { mode: 0o600 });
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  appendAuditRecord(workspaceId, record);
}

export function appendCheckpointRecord(workspaceId: string, record: CheckpointRecord): void {
  appendAuditRecord(workspaceId, record);
}

export function readAuditLog(workspaceId: string, taskId?: string): AuditLog {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return { records: [], integrity: { ok: true, totalLines: 0, corruptLines: [], errors: [], bounded: true } };
  const stat = fs.statSync(file);
  const errors: string[] = [];
  if (stat.size > MAX_AUDIT_BYTES) errors.push(`audit log exceeds ${MAX_AUDIT_BYTES} bytes`);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > MAX_AUDIT_LINES) errors.push(`audit log exceeds ${MAX_AUDIT_LINES} lines`);
  const records: AuditRecord[] = [];
  const identities = new Map<string, AuditRecord>();
  const corruptLines: number[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) throw new Error("unknown schemaVersion");
      if (parsed.authority !== undefined && parsed.authority !== AUDIT_AUTHORITY) throw new Error("invalid authority");
      const normalized = normalizeRecord(parsed);
      const identity = recordIdentity(normalized);
      const previous = identities.get(identity);
      if (previous) {
        if (comparable(previous) !== comparable(normalized)) throw new Error(`conflicting audit record: ${identity}`);
        continue;
      }
      identities.set(identity, normalized);
      if (!taskId || normalized.taskId === taskId) records.push(normalized);
    } catch (error) {
      corruptLines.push(index + 1);
      errors.push(`line ${index + 1}: ${error instanceof Error ? error.message : "invalid record"}`);
    }
  }
  return {
    records,
    integrity: { ok: errors.length === 0, totalLines: lines.length, corruptLines, errors: errors.slice(0, 20), bounded: stat.size <= MAX_AUDIT_BYTES && lines.length <= MAX_AUDIT_LINES },
  };
}

export function readAuditRecords(workspaceId: string, limit = 10, taskId?: string): AuditRecord[] {
  return readAuditLog(workspaceId, taskId).records.slice(-limit);
}

export function readExecutionRecords(workspaceId: string, limit = 10, taskId?: string): ExecutionRecord[] {
  return readAuditRecords(workspaceId, Number.MAX_SAFE_INTEGER, taskId)
    .filter((record): record is ExecutionRecord => record.kind !== "checkpoint")
    .slice(-limit);
}

export function latestExecutionRecord(workspaceId: string, taskId?: string): ExecutionRecord | null {
  return readExecutionRecords(workspaceId, 1, taskId)[0] ?? null;
}

export function latestCheckpointRecord(workspaceId: string, taskId?: string): CheckpointRecord | null {
  return readAuditRecords(workspaceId, Number.MAX_SAFE_INTEGER, taskId)
    .filter((record): record is CheckpointRecord => record.kind === "checkpoint")
    .at(-1) ?? null;
}

export function completionEvidence(workspaceId: string, taskId: string, iteration?: number) {
  const log = readAuditLog(workspaceId, taskId);
  const checkpoint = log.records
    .filter((record): record is CheckpointRecord => record.kind === "checkpoint")
    .filter((record) => iteration === undefined || record.iteration === iteration)
    .at(-1) ?? null;
  const selectedIteration = iteration ?? checkpoint?.iteration;
  const execution = log.records
    .filter((record): record is ExecutionRecord => record.kind !== "checkpoint")
    .filter((record) => selectedIteration !== undefined && record.iteration === selectedIteration)
    .at(-1) ?? null;
  const checks = {
    integrityOk: log.integrity.ok,
    executionRecorded: execution !== null,
    executionSucceeded: execution?.exitStatus === "ok",
    testsRecorded: Boolean(execution?.tests?.trim()),
    terminalCheckpoint: checkpoint?.state === "DONE",
    noKnownIssues: checkpoint !== null && checkpoint.knownIssues.length === 0,
    latestTaskIteration: selectedIteration !== undefined && log.records.every((record) => record.iteration <= selectedIteration),
    reviewedAfterExecution: execution !== null && checkpoint !== null && log.records.indexOf(checkpoint) > log.records.indexOf(execution),
  };
  return { pass: Object.values(checks).every(Boolean), checks, selectedIteration: selectedIteration ?? null, integrity: log.integrity, execution, checkpoint };
}
