import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

const MAX_TEXT = 2_000;
const MAX_ITEMS = 50;

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
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

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

function boundedText(value: string, field: string): string {
  if (value.length > MAX_TEXT) throw new Error(`${field} exceeds ${MAX_TEXT} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} contains control characters`);
  }
  return value;
}

function boundedItems(values: string[], field: string): string[] {
  if (values.length > MAX_ITEMS) throw new Error(`${field} exceeds ${MAX_ITEMS} items`);
  return values.map((value) => boundedText(value, field));
}

function normalizeRecord(record: AuditRecord): AuditRecord {
  if (!record.taskId || !Number.isInteger(record.iteration) || record.iteration < 0) {
    throw new Error("taskId and a non-negative integer iteration are required");
  }
  if (record.kind === "checkpoint") {
    return {
      ...record,
      state: boundedText(record.state, "state"),
      summary: boundedText(record.summary, "summary"),
      knownIssues: boundedItems(record.knownIssues, "knownIssues"),
      nextExpectedStep: boundedText(record.nextExpectedStep, "nextExpectedStep"),
    };
  }
  return {
    ...record,
    kind: "execution",
    tests: record.tests === null ? null : boundedText(record.tests, "tests"),
    notes: record.notes === undefined ? undefined : boundedText(record.notes, "notes"),
    evidence: record.evidence === undefined ? undefined : boundedItems(record.evidence, "evidence"),
    changedFiles: Array.isArray(record.changedFiles)
      ? boundedItems(record.changedFiles, "changedFiles")
      : record.changedFiles,
  };
}

export function appendAuditRecord(workspaceId: string, record: AuditRecord): void {
  const file = recordsFile(workspaceId);
  fs.appendFileSync(file, JSON.stringify(normalizeRecord(record)) + "\n", { mode: 0o600 });
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  appendAuditRecord(workspaceId, record);
}

export function appendCheckpointRecord(workspaceId: string, record: CheckpointRecord): void {
  appendAuditRecord(workspaceId, record);
}

export function readAuditRecords(workspaceId: string, limit = 10, taskId?: string): AuditRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: AuditRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      if (!taskId || parsed.taskId === taskId) records.push(parsed);
    } catch {
      // skip corrupt lines
    }
  }
  return records.slice(-limit);
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
  const execution = readExecutionRecords(workspaceId, Number.MAX_SAFE_INTEGER, taskId)
    .filter((record) => iteration === undefined || record.iteration === iteration)
    .at(-1) ?? null;
  const checkpoint = readAuditRecords(workspaceId, Number.MAX_SAFE_INTEGER, taskId)
    .filter((record): record is CheckpointRecord => record.kind === "checkpoint")
    .filter((record) => iteration === undefined || record.iteration === iteration)
    .at(-1) ?? null;
  const checks = {
    executionRecorded: execution !== null,
    executionSucceeded: execution?.exitStatus === "ok",
    testsRecorded: Boolean(execution?.tests?.trim()),
    terminalCheckpoint: checkpoint?.state === "DONE",
  };
  return { pass: Object.values(checks).every(Boolean), checks, execution, checkpoint };
}
