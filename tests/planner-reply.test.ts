import { describe, expect, it } from "vitest";
import { validatePlannerReply, type PlannerRequest } from "../src/execution/planner-reply.js";

const request: PlannerRequest = {
  taskId: "demo", requestId: "request-2", iteration: 1,
  conversationUrl: "https://chatgpt.com/c/demo-123", mode: "review",
};
const reply = {
  ...request, version: 1, state: "PLAN", summary: "Fix the empty-input case",
  rationale: ["The empty input reaches an invalid index"],
  actions: ["Handle empty input in src/parse.ts"], tests: ["Run empty input regression"],
  successCriteria: ["Empty input returns an empty list"], issues: [], sources: [],
};

describe("planner loop reply boundary", () => {
  it("accepts a matching review revision and a later completed review", () => {
    expect(validatePlannerReply(JSON.stringify(reply), request).state).toBe("PLAN");
    expect(validatePlannerReply(JSON.stringify({ ...reply, state: "DONE", actions: [] }), request).state).toBe("DONE");
  });
  it.each(["taskId", "requestId", "iteration", "conversationUrl", "mode"] as const)("rejects stale or unrelated %s", (key) => {
    const replacements = { taskId: "other", requestId: "old", iteration: 0,
      conversationUrl: "https://chatgpt.com/c/other", mode: "plan" };
    expect(() => validatePlannerReply(JSON.stringify({ ...reply, [key]: replacements[key] }), request)).toThrow("REPLY_MISMATCH");
  });
  it("rejects partial generation and multiple answers instead of guessing", () => {
    expect(() => validatePlannerReply(JSON.stringify(reply).slice(0, -3), request)).toThrow("INVALID_REPLY_JSON");
    expect(() => validatePlannerReply(JSON.stringify(reply) + JSON.stringify(reply), request)).toThrow();
  });
  it("does not let an initial plan or research response complete execution", () => {
    for (const mode of ["plan", "research"] as const) {
      expect(() => validatePlannerReply(JSON.stringify({ ...reply, mode, state: "DONE", actions: [] }), { ...request, mode })).toThrow("UNEXPECTED_REPLY_STATE");
    }
  });
  it("requires actionable plans and explicit unresolved-work-free DONE", () => {
    expect(() => validatePlannerReply(JSON.stringify({ ...reply, tests: [] }), request)).toThrow("INCOMPLETE_PLAN");
    expect(() => validatePlannerReply(JSON.stringify({ ...reply, state: "DONE" }), request)).toThrow("DONE_HAS_UNRESOLVED_WORK");
    expect(() => validatePlannerReply(JSON.stringify({ ...reply, state: "DONE", actions: [], issues: ["not tested"] }), request)).toThrow();
  });
  it("requires research source claims before advancing to a separate plan", () => {
    const research = { ...reply, mode: "research", state: "RESEARCH" };
    const expected = { ...request, mode: "research" as const };
    expect(() => validatePlannerReply(JSON.stringify(research), expected)).toThrow("RESEARCH_SOURCES_REQUIRED");
    expect(validatePlannerReply(JSON.stringify({ ...research, sources: [{ url: "https://example.com/paper", claim: "A candidate to verify" }] }), expected).state).toBe("RESEARCH");
  });
  it("supports a single fenced answer and rejects unknown fields and oversized output", () => {
    expect(validatePlannerReply("```json\n" + JSON.stringify(reply) + "\n```", request).state).toBe("PLAN");
    expect(() => validatePlannerReply(JSON.stringify({ ...reply, command: "do something" }), request)).toThrow("INVALID_REPLY_SCHEMA");
    expect(() => validatePlannerReply("x".repeat(65537), request)).toThrow("REPLY_TOO_LARGE");
  });
  it("keeps blocked work explicit", () => {
    expect(() => validatePlannerReply(JSON.stringify({ ...reply, state: "BLOCKED" }), request)).toThrow("BLOCKER_REQUIRED");
    expect(validatePlannerReply(JSON.stringify({ ...reply, state: "BLOCKED", issues: ["Login required"] }), request).state).toBe("BLOCKED");
  });
});
