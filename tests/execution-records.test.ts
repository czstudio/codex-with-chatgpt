import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  appendCheckpointRecord,
  appendExecutionRecord,
  completionEvidence,
  latestCheckpointRecord,
  readAuditLog,
  readAuditRecords,
  readExecutionRecords,
} from "../src/execution/records.js";
import { isolateStateDir } from "./helpers.js";

describe("task-bound execution audit", () => {
  beforeEach(() => isolateStateDir());

  it("keeps legacy execution reads compatible while exposing checkpoints", () => {
    appendExecutionRecord("ws", {
      taskId: "task-a", iteration: 1, changedFiles: 2, tests: "3 passed",
      exitStatus: "ok", timestamp: "2026-08-30T00:00:00Z",
    });
    appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-a", iteration: 1, state: "EXECUTED",
      summary: "implementation complete", knownIssues: [], nextExpectedStep: "review",
      timestamp: "2026-08-30T00:01:00Z",
    });

    expect(readExecutionRecords("ws", 10)).toHaveLength(1);
    expect(readAuditRecords("ws", 10)).toHaveLength(2);
    expect(latestCheckpointRecord("ws", "task-a")?.nextExpectedStep).toBe("review");
  });

  it("filters recovery history by task and requires explicit DONE evidence", () => {
    appendExecutionRecord("ws", {
      taskId: "task-a", iteration: 2, changedFiles: ["src/a.ts"], tests: "9 passed",
      exitStatus: "ok", timestamp: "2026-08-30T00:00:00Z",
    });
    appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-a", iteration: 2, state: "DONE",
      summary: "review accepted", knownIssues: [], nextExpectedStep: "report",
      timestamp: "2026-08-30T00:01:00Z",
    });
    appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-b", iteration: 1, state: "BLOCKED",
      summary: "missing tests", knownIssues: ["no receipt"], nextExpectedStep: "run tests",
      timestamp: "2026-08-30T00:02:00Z",
    });

    expect(readAuditRecords("ws", 10, "task-a")).toHaveLength(2);
    expect(completionEvidence("ws", "task-a", 2).pass).toBe(true);
    const blocked = completionEvidence("ws", "task-b", 1);
    expect(blocked.pass).toBe(false);
    expect(blocked.checks.executionRecorded).toBe(false);
    expect(blocked.checks.terminalCheckpoint).toBe(false);
  });

  it("rejects oversized or control-character checkpoint payloads", () => {
    expect(() => appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-a", iteration: 1, state: "PLAN",
      summary: "x".repeat(2001), knownIssues: [], nextExpectedStep: "execute",
      timestamp: "2026-08-30T00:00:00Z",
    })).toThrow(/exceeds/);
    expect(() => appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-a", iteration: 1, state: "PLAN\u0000",
      summary: "ok", knownIssues: [], nextExpectedStep: "execute",
      timestamp: "2026-08-30T00:00:00Z",
    })).toThrow(/control/);
  });

  it("surfaces valid records around an interruption but fails the completion gate closed", () => {
    appendCheckpointRecord("ws-corrupt", {
      kind: "checkpoint", taskId: "task-a", iteration: 1, state: "EXECUTED",
      summary: "before interruption", knownIssues: [], nextExpectedStep: "review",
      timestamp: "2026-08-30T00:00:00Z",
    });
    const stateDir = process.env.C2C_STATE_DIR!;
    fs.appendFileSync(path.join(stateDir, "executions", "ws-corrupt.jsonl"), "{interrupted\n");
    const log = readAuditLog("ws-corrupt", "task-a");
    expect(log.records).toHaveLength(1);
    expect(log.integrity.ok).toBe(false);
    expect(log.integrity.corruptLines).toEqual([2]);
    expect(completionEvidence("ws-corrupt", "task-a", 1).pass).toBe(false);
    expect(() => appendCheckpointRecord("ws-corrupt", {
      kind: "checkpoint", taskId: "task-a", iteration: 2, state: "DONE",
      summary: "must not hide corruption", knownIssues: [], nextExpectedStep: "repair",
      timestamp: "2026-08-30T00:01:00Z",
    })).toThrow(/integrity failure/);
  });

  it("is idempotent for identical records and rejects conflicting identities", () => {
    const record = {
      taskId: "task-a", iteration: 1, changedFiles: 1, tests: "1 passed",
      exitStatus: "ok", timestamp: "2026-08-30T00:00:00Z",
    } as const;
    appendExecutionRecord("ws", record);
    appendExecutionRecord("ws", { ...record, timestamp: "2026-08-30T00:01:00Z" });
    expect(readAuditRecords("ws", 10)).toHaveLength(1);
    expect(() => appendExecutionRecord("ws", { ...record, tests: "2 passed" })).toThrow(/conflicting/);
  });

  it("does not borrow DONE evidence across iterations or tasks", () => {
    appendExecutionRecord("ws", {
      taskId: "task-a", iteration: 1, changedFiles: 1, tests: "1 passed", exitStatus: "ok",
      timestamp: "2026-08-30T00:00:00Z",
    });
    appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-a", iteration: 2, state: "DONE", summary: "wrong iteration",
      knownIssues: [], nextExpectedStep: "report", timestamp: "2026-08-30T00:01:00Z",
    });
    appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-b", iteration: 1, state: "DONE", summary: "wrong task",
      knownIssues: [], nextExpectedStep: "report", timestamp: "2026-08-30T00:02:00Z",
    });
    expect(completionEvidence("ws", "task-a").pass).toBe(false);
    expect(completionEvidence("ws", "task-b", 1).pass).toBe(false);
  });

  it("rejects unresolved issues, pre-execution DONE and obsolete iteration completion", () => {
    const execution = { taskId: "a", iteration: 1, changedFiles: 0, tests: "1 passed", exitStatus: "ok", timestamp: "2026-09-05T00:00:00Z" };
    const done = { kind: "checkpoint" as const, taskId: "a", iteration: 1, state: "DONE", summary: "reviewed", knownIssues: [], nextExpectedStep: "report", timestamp: "2026-09-05T00:01:00Z" };
    appendExecutionRecord("issues", execution);
    appendCheckpointRecord("issues", { ...done, knownIssues: ["Missing acceptance test"] });
    expect(completionEvidence("issues", "a", 1).pass).toBe(false);
    appendCheckpointRecord("early", done);
    appendExecutionRecord("early", execution);
    expect(completionEvidence("early", "a", 1).pass).toBe(false);
    appendExecutionRecord("stale", execution);
    appendCheckpointRecord("stale", done);
    appendExecutionRecord("stale", { ...execution, iteration: 2, exitStatus: "failed" });
    expect(completionEvidence("stale", "a", 1).pass).toBe(false);
  });

  it("rejects credential-like content and unknown schemas", () => {
    expect(() => appendCheckpointRecord("ws", {
      kind: "checkpoint", taskId: "task-a", iteration: 1, state: "BLOCKED",
      summary: "token=supersecretvalue", knownIssues: [], nextExpectedStep: "rotate",
      timestamp: "2026-08-30T00:00:00Z",
    })).toThrow(/credential-like/);
    const stateDir = process.env.C2C_STATE_DIR!;
    const dir = path.join(stateDir, "executions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ws-unknown.jsonl"), JSON.stringify({
      schemaVersion: 99, authority: "local-audit-hint-only", kind: "checkpoint", taskId: "a",
      iteration: 1, state: "DONE", summary: "x", knownIssues: [], nextExpectedStep: "x", timestamp: "x",
    }) + "\n");
    expect(readAuditLog("ws-unknown").integrity.ok).toBe(false);
    expect(completionEvidence("ws-unknown", "a", 1).pass).toBe(false);
  });

  it("deduplicates concurrent-equivalent lines and blocks concurrent conflicts", () => {
    const stateDir = process.env.C2C_STATE_DIR!;
    const dir = path.join(stateDir, "executions");
    fs.mkdirSync(dir, { recursive: true });
    const base = {
      schemaVersion: 1, authority: "local-audit-hint-only", kind: "execution", taskId: "task-a",
      iteration: 1, changedFiles: 1, tests: "1 passed", exitStatus: "ok",
      timestamp: "2026-08-30T00:00:00Z",
    };
    const file = path.join(dir, "ws-race.jsonl");
    fs.writeFileSync(file, `${JSON.stringify(base)}\n${JSON.stringify({ ...base, timestamp: "2026-08-30T00:00:01Z" })}\n`);
    expect(readAuditLog("ws-race").records).toHaveLength(1);
    expect(readAuditLog("ws-race").integrity.ok).toBe(true);
    fs.appendFileSync(file, `${JSON.stringify({ ...base, tests: "different" })}\n`);
    expect(readAuditLog("ws-race").integrity.ok).toBe(false);
    expect(completionEvidence("ws-race", "task-a", 1).pass).toBe(false);
  });
});
