import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  appendCheckpointRecord,
  appendExecutionRecord,
  completionEvidence,
  latestCheckpointRecord,
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

  it("recovers valid records around a corrupt or interrupted append", () => {
    appendCheckpointRecord("ws-corrupt", {
      kind: "checkpoint", taskId: "task-a", iteration: 1, state: "EXECUTED",
      summary: "before interruption", knownIssues: [], nextExpectedStep: "review",
      timestamp: "2026-08-30T00:00:00Z",
    });
    const stateDir = process.env.C2C_STATE_DIR!;
    fs.appendFileSync(path.join(stateDir, "executions", "ws-corrupt.jsonl"), "{interrupted\n");
    appendCheckpointRecord("ws-corrupt", {
      kind: "checkpoint", taskId: "task-a", iteration: 2, state: "DONE",
      summary: "recovered", knownIssues: [], nextExpectedStep: "report",
      timestamp: "2026-08-30T00:01:00Z",
    });

    const records = readAuditRecords("ws-corrupt", 10, "task-a");
    expect(records).toHaveLength(2);
    expect(latestCheckpointRecord("ws-corrupt", "task-a")?.summary).toBe("recovered");
  });
});
