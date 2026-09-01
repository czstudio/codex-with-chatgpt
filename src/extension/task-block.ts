import type { TaskOperation } from "../inbox/task-inbox.js";
import { validateApproval } from "../inbox/approval.js";

export const MAX_BLOCK_BYTES = 4_096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const BLOCK_KEYS = [
  "VERSION",
  "TASK_ID",
  "WORKSPACE_ID",
  "OPERATION",
  "ATTEMPT",
  "ARM_ID",
  "IDEMPOTENCY_KEY",
  "TASK_SUMMARY",
  "INSTRUCTION",
  "APPROVAL_SUMMARY_HASH",
] as const;

export type C2CTaskBlock = {
  taskId: string;
  workspaceId: string;
  operation: TaskOperation;
  attempt: 1;
  armId: string;
  idempotencyKey: string;
  taskSummary: string;
  instruction: string;
  approvalSummaryHash: string;
};

export type TaskBlockErrorCode =
  | "BLOCK_TOO_LARGE"
  | "INVALID_BLOCK"
  | "INVALID_FIELD"
  | "OPERATION_NOT_ALLOWED"
  | "ATTEMPT_INVALID";

export class TaskBlockError extends Error {
  constructor(public readonly code: TaskBlockErrorCode, message: string = code) {
    super(`${code}: ${message}`);
    this.name = "TaskBlockError";
  }
}

function assertBlockSize(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_BLOCK_BYTES) {
    throw new TaskBlockError("BLOCK_TOO_LARGE", `task block exceeds ${MAX_BLOCK_BYTES} bytes`);
  }
}

function assertId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new TaskBlockError("INVALID_FIELD", `${field} is not a safe identifier`);
}

function unwrap(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  const trimmed = normalized.trim();
  if (trimmed.startsWith("```")) {
    const match = /^```c2c-task\n([\s\S]*?)\n```$/.exec(trimmed);
    if (!match) throw new TaskBlockError("INVALID_BLOCK", "only the exact c2c-task fence is accepted");
    return match[1];
  }
  // ChatGPT can render the fence language as the first code-node line while
  // stripping the surrounding backticks. Accept that DOM shape only when the
  // language line and the task marker line are both exact.
  if (normalized.startsWith("c2c-task\n")) {
    const body = normalized.slice("c2c-task\n".length).trim();
    if (!body.startsWith("[C2C_TASK]\n")) {
      throw new TaskBlockError("INVALID_BLOCK", "rendered c2c-task language must be followed by [C2C_TASK]");
    }
    return body;
  }
  return trimmed;
}

/**
 * Parse the only browser-to-local control message accepted by the bridge.
 * The parser intentionally does not have a prompt, URL, command or free-form
 * payload field. Keep this format in sync with extension/content.js. The
 * summary, instruction and hash are approved values from the local arm; the
 * bridge compares them with the durable envelope before dispatching.
 */
export function parseTaskBlock(value: unknown): C2CTaskBlock {
  if (typeof value !== "string") throw new TaskBlockError("INVALID_BLOCK", "task block must be text");
  assertBlockSize(value);
  const body = unwrap(value);
  const lines = body.split("\n");
  if (lines.length !== BLOCK_KEYS.length + 2 || lines[0] !== "[C2C_TASK]" || lines.at(-1) !== "[/C2C_TASK]" ||
      lines.slice(1, -1).some((line) => !/^[A-Z_]+: [^\r\n]+$/.test(line))) {
    throw new TaskBlockError("INVALID_BLOCK", "task block shape is not canonical");
  }

  const entries = new Map<string, string>();
  for (const [index, line] of lines.slice(1, -1).entries()) {
    const separator = line.indexOf(": ");
    const key = line.slice(0, separator);
    const fieldValue = line.slice(separator + 2);
    if (key !== BLOCK_KEYS[index] || entries.has(key)) {
      throw new TaskBlockError("INVALID_BLOCK", "task block fields must be ordered and unique");
    }
    entries.set(key, fieldValue);
  }

  if (entries.get("VERSION") !== "1") throw new TaskBlockError("INVALID_BLOCK", "unsupported task block version");
  const taskId = entries.get("TASK_ID") ?? "";
  const workspaceId = entries.get("WORKSPACE_ID") ?? "";
  const armId = entries.get("ARM_ID") ?? "";
  const idempotencyKey = entries.get("IDEMPOTENCY_KEY") ?? "";
  const taskSummary = entries.get("TASK_SUMMARY");
  const instruction = entries.get("INSTRUCTION");
  const approvalSummaryHash = entries.get("APPROVAL_SUMMARY_HASH");
  assertId(taskId, "TASK_ID");
  assertId(workspaceId, "WORKSPACE_ID");
  assertId(armId, "ARM_ID");
  assertId(idempotencyKey, "IDEMPOTENCY_KEY");
  if (entries.get("OPERATION") !== "codex_turn") {
    throw new TaskBlockError("OPERATION_NOT_ALLOWED", "only codex_turn is accepted");
  }
  if (entries.get("ATTEMPT") !== "1") throw new TaskBlockError("ATTEMPT_INVALID", "only attempt 1 is accepted");
  try {
    const approval = validateApproval(taskSummary, instruction, approvalSummaryHash);
    return {
      taskId,
      workspaceId,
      operation: "codex_turn",
      attempt: 1,
      armId,
      idempotencyKey,
      ...approval,
    };
  } catch (error) {
    if (error instanceof Error) throw new TaskBlockError("INVALID_FIELD", error.message);
    throw new TaskBlockError("INVALID_FIELD", "approved task fields are invalid");
  }
}

export function formatTaskBlock(block: C2CTaskBlock): string {
  let approval: ReturnType<typeof validateApproval>;
  try {
    approval = validateApproval(block.taskSummary, block.instruction, block.approvalSummaryHash);
  } catch (error) {
    if (error instanceof Error) throw new TaskBlockError("INVALID_FIELD", error.message);
    throw new TaskBlockError("INVALID_FIELD", "approved task fields are invalid");
  }
  // Validate before formatting so callers cannot create a block which the
  // browser and local bridge disagree about.
  const normalized = parseTaskBlock([
    "[C2C_TASK]",
    "VERSION: 1",
    `TASK_ID: ${block.taskId}`,
    `WORKSPACE_ID: ${block.workspaceId}`,
    `OPERATION: ${block.operation}`,
    `ATTEMPT: ${block.attempt}`,
    `ARM_ID: ${block.armId}`,
    `IDEMPOTENCY_KEY: ${block.idempotencyKey}`,
    `TASK_SUMMARY: ${approval.taskSummary}`,
    `INSTRUCTION: ${approval.instruction}`,
    `APPROVAL_SUMMARY_HASH: ${approval.approvalSummaryHash}`,
    "[/C2C_TASK]",
  ].join("\n"));
  return [
    "[C2C_TASK]",
    "VERSION: 1",
    `TASK_ID: ${normalized.taskId}`,
    `WORKSPACE_ID: ${normalized.workspaceId}`,
    `OPERATION: ${normalized.operation}`,
    `ATTEMPT: ${normalized.attempt}`,
    `ARM_ID: ${normalized.armId}`,
    `IDEMPOTENCY_KEY: ${normalized.idempotencyKey}`,
    `TASK_SUMMARY: ${normalized.taskSummary}`,
    `INSTRUCTION: ${normalized.instruction}`,
    `APPROVAL_SUMMARY_HASH: ${normalized.approvalSummaryHash}`,
    "[/C2C_TASK]",
  ].join("\n");
}
