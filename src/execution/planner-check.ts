import fs from "node:fs";
import { parsePlannerJson, plannerRequestSchema, validatePlannerReply } from "./planner-reply.js";

// Only these fixed strings may leave the checker. Never echo parser messages,
// user-provided field names, source text, file paths, or filesystem diagnostics.
const recovery = {
  INVALID_REQUEST: "repair-local-request",
  INPUT_UNREADABLE: "check-local-input-files",
  INPUT_NOT_BOUNDED_FILE: "check-local-input-files",
  REPLY_TOO_LARGE: "reduce-reply-size",
  INVALID_REPLY_FENCE: "request-format-correction",
  INVALID_REPLY_JSON: "request-format-correction",
  INVALID_REPLY_JSON_DUPLICATE_KEY: "inspect-ambiguous-reply",
  INVALID_REPLY_SCHEMA: "request-schema-correction",
  REPLY_MISMATCH_taskId: "inspect-conversation-and-round",
  REPLY_MISMATCH_requestId: "inspect-conversation-and-round",
  REPLY_MISMATCH_iteration: "inspect-conversation-and-round",
  REPLY_MISMATCH_conversationUrl: "inspect-conversation-and-round",
  REPLY_MISMATCH_mode: "inspect-conversation-and-round",
  UNEXPECTED_REPLY_STATE: "request-phase-correction",
  INCOMPLETE_PLAN: "request-complete-proposal",
  INCOMPLETE_IDEAS: "request-complete-proposal",
  RESEARCH_SOURCES_REQUIRED: "request-research-sources",
  DONE_HAS_UNRESOLVED_WORK: "resolve-unfinished-work",
  BLOCKER_REQUIRED: "request-blocker-details",
  UNKNOWN_REJECTION: "inspect-local-request-and-reply",
} as const;
type Reason = keyof typeof recovery;

function reject(reason: Reason) {
  return { ok: false as const, error: "PLANNER_REPLY_REJECTED", reason,
    next: recovery[reason], authority: "proposal-only" as const };
}

/** Diagnostics describe recovery, never permission to resend or execute. */
export function checkPlannerReply(requestRaw: string, replyRaw: string) {
  let expected;
  try { expected = plannerRequestSchema.parse(parsePlannerJson(requestRaw)); }
  catch { return reject("INVALID_REQUEST"); }
  try {
    const reply = validatePlannerReply(replyRaw, expected);
    return { ok: true as const, authority: "proposal-only" as const, state: reply.state,
      taskId: reply.taskId, requestId: reply.requestId, iteration: reply.iteration,
      next: reply.state === "DONE" ? "verify-local-evidence" : reply.state === "PLAN" ? "local-adoption-review" : reply.state === "BLOCKED" ? "resolve-blocker" : "request-plan" };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return reject(Object.hasOwn(recovery, code) ? code as Reason : "UNKNOWN_REJECTION");
  }
}

function readBoundedFile(file: string): string {
  // Read the same opened regular file we inspect, with a hard byte ceiling even
  // if another writer grows it after fstat. O_NONBLOCK avoids hanging on a FIFO.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error("INPUT_NOT_BOUNDED_FILE");
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > 65536) throw new Error("INPUT_NOT_BOUNDED_FILE");
    return buffer.subarray(0, size).toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function checkPlannerReplyFiles(requestFile: string, replyFile: string) {
  let requestRaw: string, replyRaw: string;
  try {
    requestRaw = readBoundedFile(requestFile);
    replyRaw = readBoundedFile(replyFile);
  } catch (error) {
    return reject(error instanceof Error && error.message === "INPUT_NOT_BOUNDED_FILE"
      ? "INPUT_NOT_BOUNDED_FILE" : "INPUT_UNREADABLE");
  }
  return checkPlannerReply(requestRaw, replyRaw);
}
