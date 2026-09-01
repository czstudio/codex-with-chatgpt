import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexTurnInvoker, CodexTurnOutcome, CodexTurnRequest } from "./task-dispatcher.js";
import { validateApproval } from "./approval.js";

export const CODEX_EXECUTABLE = "codex" as const;
export const DEFAULT_CODEX_PROMPT =
  "Work only inside the already-approved local workspace. Do not use browser state, credentials, session recovery, or network tools. Do not bypass approval or sandbox policy. Return a short completion summary.";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_EVENT_LINES = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

export type CodexProcessOptions = {
  cwd: string;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
  timeoutMs: number;
  input: string;
};

export type CodexProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
};

export type CodexProcessRunner = (
  executable: string,
  args: readonly string[],
  options: CodexProcessOptions
) => Promise<CodexProcessResult>;

function appendBounded(current: string, chunk: string): { value: string; truncated: boolean } {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return { value: current, truncated: true };
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.byteLength <= remaining) return { value: current + chunk, truncated: false };
  return { value: current + bytes.subarray(0, remaining).toString("utf8"), truncated: true };
}

function runCodexProcess(executable: string, args: readonly string[], options: CodexProcessOptions): Promise<CodexProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        shell: false,
        stdio: options.stdio,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const next = appendBounded(stdout, chunk);
      stdout = next.value;
      outputTruncated ||= next.truncated;
      if (outputTruncated) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: string) => {
      const next = appendBounded(stderr, chunk);
      stderr = next.value;
      outputTruncated ||= next.truncated;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stdout, stderr, timedOut, outputTruncated });
    });
    child.stdin.end(options.input);
  });
}

function hasOnlyExpectedEvents(stdout: string): { valid: boolean; failed: boolean; error: boolean } {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0 || lines.length > MAX_EVENT_LINES) return { valid: false, failed: false, error: false };
  let failed = false;
  let error = false;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: unknown };
      if (!event || typeof event.type !== "string") return { valid: false, failed, error };
      if (event.type === "turn.failed") failed = true;
      if (event.type === "error") error = true;
    } catch {
      return { valid: false, failed, error };
    }
  }
  return { valid: true, failed, error };
}

function blocked(notes: string): CodexTurnOutcome {
  return { exitStatus: "blocked", tests: null, changedFiles: 0, notes };
}

/**
 * A real Codex CLI seam with a deliberately closed command surface. The task
 * request carries only the bounded, locally armed approval fields; it can
 * change stdin content but can never change executable, argv, cwd, sandbox or
 * approval policy.
 */
export class CodexCliInvoker {
  private readonly executable: string;
  private readonly workspaceRoot: string;
  private readonly prompt: string;
  private readonly timeoutMs: number;
  private readonly run: CodexProcessRunner;

  constructor(options: {
    workspaceRoot: string;
    timeoutMs?: number;
    run?: CodexProcessRunner;
  }) {
    if (!path.isAbsolute(options.workspaceRoot) || /[\u0000-\u001f\u007f]/.test(options.workspaceRoot)) {
      throw new Error("CODEX_WORKSPACE_INVALID");
    }
    this.workspaceRoot = fs.realpathSync.native(options.workspaceRoot);
    this.executable = CODEX_EXECUTABLE;
    this.prompt = DEFAULT_CODEX_PROMPT;
    if (this.prompt.length === 0 || this.prompt.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(this.prompt)) {
      throw new Error("CODEX_PROMPT_INVALID");
    }
    this.timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    this.run = options.run ?? runCodexProcess;
  }

  async invoke(request: CodexTurnRequest): Promise<CodexTurnOutcome> {
    let prompt: string;
    try {
      const approval = validateApproval(request.taskSummary, request.instruction, request.approvalSummaryHash);
      prompt = [
        "Execute exactly this locally armed task:",
        `TASK_SUMMARY: ${approval.taskSummary}`,
        `INSTRUCTION: ${approval.instruction}`,
        `APPROVAL_SUMMARY_HASH: ${approval.approvalSummaryHash}`,
        "",
        this.prompt,
      ].join("\n");
    } catch {
      return blocked("APPROVED_TASK_INVALID");
    }
    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--cd",
      this.workspaceRoot,
      "-",
    ] as const;
    let processResult: CodexProcessResult;
    try {
      processResult = await this.run(this.executable, args, {
        cwd: this.workspaceRoot,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        timeoutMs: this.timeoutMs,
        input: prompt,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return blocked("CODEX_CLI_UNAVAILABLE");
      return blocked("CODEX_CLI_FAILED");
    }

    if (processResult.timedOut) return blocked("CODEX_CLI_TIMEOUT");
    if (processResult.outputTruncated) return blocked("CODEX_CLI_OUTPUT_LIMIT");
    if (processResult.exitCode !== 0) {
      return {
        exitStatus: "failed",
        tests: null,
        changedFiles: 0,
        notes: processResult.signal ? "CODEX_CLI_SIGNAL" : "CODEX_CLI_EXIT_NONZERO",
      };
    }

    const events = hasOnlyExpectedEvents(processResult.stdout);
    if (!events.valid) return blocked("CODEX_CLI_PROTOCOL_FAILURE");
    if (events.failed || events.error) return { exitStatus: "failed", tests: null, changedFiles: 0, notes: "CODEX_CLI_TURN_FAILED" };
    return { exitStatus: "ok", tests: null, changedFiles: 0, notes: "CODEX_CLI_COMPLETED" };
  }
}

export function createCodexCliInvoker(options: ConstructorParameters<typeof CodexCliInvoker>[0]): CodexTurnInvoker {
  const invoker = new CodexCliInvoker(options);
  return invoker.invoke.bind(invoker);
}
