import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
const text = z.string().trim().min(1).max(2000);
const texts = z.array(text).max(30);
const binding = {
  taskId: id,
  requestId: id,
  iteration: z.number().int().min(0).max(10000),
  conversationUrl: z.string().regex(/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/),
  mode: z.enum(["brainstorm", "research", "plan", "review"]),
};

export const plannerRequestSchema = z.object(binding).strict();
export type PlannerRequest = z.infer<typeof plannerRequestSchema>;
const replySchema = z.object({
  ...binding,
  version: z.literal(1),
  state: z.enum(["IDEAS", "RESEARCH", "PLAN", "DONE", "BLOCKED"]),
  summary: text,
  rationale: texts,
  actions: texts,
  tests: texts,
  successCriteria: texts,
  issues: texts,
  sources: z.array(z.object({
    url: z.string().url().max(2000).refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }),
    claim: text,
  }).strict()).max(30),
}).strict();

export type PlannerReply = z.infer<typeof replySchema>;

/** A syntax/correlation check, never permission to execute web-provided actions. */
export function validatePlannerReply(raw: string, expected: PlannerRequest): PlannerReply {
  const request = plannerRequestSchema.parse(expected);
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("REPLY_TOO_LARGE");
  let body = raw.trim();
  if (body.startsWith("```")) {
    const match = /^```(?:json|c2c-reply)\n([\s\S]*?)\n```$/.exec(body);
    if (!match) throw new Error("INVALID_REPLY_FENCE");
    body = match[1];
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("INVALID_REPLY_JSON"); }
  const result = replySchema.safeParse(parsed);
  if (!result.success) throw new Error("INVALID_REPLY_SCHEMA");
  const reply = result.data;
  for (const key of Object.keys(request) as Array<keyof PlannerRequest>) {
    if (reply[key] !== request[key]) throw new Error(`REPLY_MISMATCH_${key}`);
  }
  const allowed = {
    brainstorm: ["IDEAS", "BLOCKED"],
    research: ["RESEARCH", "BLOCKED"],
    plan: ["PLAN", "BLOCKED"],
    review: ["PLAN", "DONE", "BLOCKED"],
  };
  if (!allowed[request.mode].includes(reply.state)) throw new Error("UNEXPECTED_REPLY_STATE");
  if (reply.state === "PLAN" && (!reply.actions.length || !reply.tests.length ||
      !reply.successCriteria.length || !reply.rationale.length)) throw new Error("INCOMPLETE_PLAN");
  if (reply.state === "IDEAS" && !reply.rationale.length) throw new Error("INCOMPLETE_IDEAS");
  if (reply.state === "RESEARCH" && (!reply.sources.length || !reply.rationale.length)) {
    throw new Error("RESEARCH_SOURCES_REQUIRED");
  }
  if (reply.state === "DONE" && (reply.issues.length || reply.actions.length || !reply.successCriteria.length)) {
    throw new Error("DONE_HAS_UNRESOLVED_WORK");
  }
  if (reply.state === "BLOCKED" && !reply.issues.length) throw new Error("BLOCKER_REQUIRED");
  return reply;
}
