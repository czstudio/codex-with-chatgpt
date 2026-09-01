import { createHash } from "node:crypto";

export const TASK_SUMMARY_MAX_BYTES = 256;
export const INSTRUCTION_MAX_BYTES = 1_024;
export const APPROVAL_SUMMARY_HASH_PATTERN = /^[a-f0-9]{64}$/;

export type ApprovalTextField = "TASK_SUMMARY" | "INSTRUCTION";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UNSAFE_APPROVAL_TEXT = [
  /(?:https?|file|ftp):\/\//i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bbearer\s+\S+/i,
  /\b(?:bearer|api[_-]?key|access[_-]?key|password|secret|token|credential|cookie|session|private[_-]?key)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /(?:&&|\|\||[|;&`<>]|\$\(|\$\{)/,
  /(?:^|[\s"'])\b(?:sudo|su|rm|rmdir|del|format|mkfs|dd|curl|wget|nc|netcat|ssh|scp|chmod|chown|launchctl|powershell|pwsh|bash|sh|zsh|cmd(?:\.exe)?|docker|kubectl)\b/i,
  /\bgit\s+(?:push|reset|clean|checkout)\b/i,
  /\b(?:npm|pnpm|yarn|pip|uv)\s+install\b/i,
  /\b(?:ignore|disregard|override)\s+(?:the\s+)?(?:previous|system|developer|safety|local)?\s*instructions?\b/i,
  /\b(?:approval|sandbox|security)\s+(?:bypass|override)\b/i,
  /--(?:dangerously-)?(?:bypass|no-approval|no-sandbox)\b/i,
];

export class ApprovalValidationError extends Error {
  constructor(public readonly code: "TASK_SUMMARY_INVALID" | "INSTRUCTION_INVALID" | "APPROVAL_HASH_INVALID", message: string) {
    super(`${code}: ${message}`);
    this.name = "ApprovalValidationError";
  }
}

function maxBytesFor(field: ApprovalTextField): number {
  return field === "TASK_SUMMARY" ? TASK_SUMMARY_MAX_BYTES : INSTRUCTION_MAX_BYTES;
}

export function validateApprovalText(value: unknown, field: ApprovalTextField): string {
  const code = field === "TASK_SUMMARY" ? "TASK_SUMMARY_INVALID" : "INSTRUCTION_INVALID";
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ApprovalValidationError(code, `${field} must be non-empty text without surrounding whitespace`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytesFor(field)) {
    throw new ApprovalValidationError(code, `${field} exceeds ${maxBytesFor(field)} bytes`);
  }
  if (CONTROL_CHARACTERS.test(value) || UNSAFE_APPROVAL_TEXT.some((pattern) => pattern.test(value))) {
    throw new ApprovalValidationError(code, `${field} contains unsafe material`);
  }
  return value;
}

export function computeApprovalSummaryHash(taskSummary: string, instruction: string): string {
  return createHash("sha256").update(`${taskSummary}\n${instruction}`, "utf8").digest("hex");
}

export function validateApproval(
  taskSummary: unknown,
  instruction: unknown,
  expectedHash?: unknown,
): { taskSummary: string; instruction: string; approvalSummaryHash: string } {
  const summary = validateApprovalText(taskSummary, "TASK_SUMMARY");
  const approvedInstruction = validateApprovalText(instruction, "INSTRUCTION");
  const approvalSummaryHash = computeApprovalSummaryHash(summary, approvedInstruction);
  if (expectedHash !== undefined && (typeof expectedHash !== "string" || !APPROVAL_SUMMARY_HASH_PATTERN.test(expectedHash) || expectedHash !== approvalSummaryHash)) {
    throw new ApprovalValidationError("APPROVAL_HASH_INVALID", "approval summary hash does not match the approved fields");
  }
  return { taskSummary: summary, instruction: approvedInstruction, approvalSummaryHash };
}
