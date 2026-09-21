// Regression fixtures for the planner-reply contract, distilled from live
// loop incidents in 2026-09 (gpt6_collab_opt_20260918 / A00 protocol package).
//
// Each case pins one behavior an operator actually hit in production, so a
// future schema or parser change cannot silently re-break the loop:
//   1. brainstorm phase only accepts IDEAS/BLOCKED (a PLAN reply there is the
//      request-side mode/phase mislabel caught on 2026-09-20);
//   2. sources[].url must be a full https URL (repo-relative paths cost one
//      wasted web round before the -fix1 format correction);
//   3. single text fields cap at 2000 chars (the 30KB PLAN reply sat right
//      under it; one long rationale item must not slip past);
//   4. duplicate JSON keys are rejected instead of last-key-wins;
//   5. fence-less raw JSON bodies are accepted (lane3 posted one);
//   6. >64KiB replies are rejected wholesale;
//   7. any of the five bound fields mismatching is named per-field;
//   8. requestId correlation is the CALLER's duty: two receipts sharing
//      taskId+iteration but differing in requestId both validate — execution
//      summaries that only correlate on taskId+iteration will conflate rounds
//      (the audit-log conflict class found on 2026-09-20);
//   9. the happy path still reads as proposal-only with next phase pointers.

import { describe, expect, it } from 'vitest';
import { validatePlannerReply } from '../src/execution/planner-reply.js';

const CONV = 'https://chatgpt.com/c/6aad2e30-d02c-83e8-8948-cbe3f2b816bc';

function request(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    taskId: 'gpt6loop_transport_20260920',
    requestId: 'gpt6loop-transport-opt-20260920',
    iteration: 3,
    conversationUrl: CONV,
    mode: 'brainstorm',
    ...overrides,
  };
}

function reply(base: Record<string, unknown>, overrides: Record<string, unknown>) {
  return JSON.stringify({ ...base, ...overrides });
}

const brainstormReply = {
  version: 1,
  taskId: 'gpt6loop_transport_20260920',
  requestId: 'gpt6loop-transport-opt-20260920',
  iteration: 3,
  conversationUrl: CONV,
  mode: 'brainstorm',
  state: 'IDEAS',
  summary: 'Transport ideas',
  rationale: ['Pipe blocks', 'Strict parse'],
  actions: ['Adopt requestId correlation'],
  tests: ['vitest run'],
  successCriteria: ['Zero browser contact'],
  issues: [],
  sources: [{ url: 'https://github.com/XiaoDu0Ya/codex-with-chatgpt/blob/main/README.md', claim: 'transport' }],
};

const planReply = {
  ...brainstormReply,
  requestId: 'gpt6-collab-opt-plan-1-fix1',
  taskId: 'gpt6_collab_opt_20260918',
  mode: 'plan',
  state: 'PLAN',
  conversationUrl: CONV,
};

function validate(requestRaw: string | object, replyRaw: string) {
  const req = typeof requestRaw === 'string' ? JSON.parse(requestRaw) : requestRaw;
  return validatePlannerReply(replyRaw, req);
}

describe('planner-reply live-incident regressions', () => {
  it('1. baseline: a well-formed brainstorm reply validates (echo shape on this ref)', () => {
    const out = validate(request(), reply(brainstormReply, {}));
    expect(out).toBeTruthy();
    expect(out.state).toBe('IDEAS');
    expect(out.requestId).toBe('gpt6loop-transport-opt-20260920');
  });

  it('2. brainstorm phase rejects state=PLAN (2026-09-20 mode/phase mislabel)', () => {
    expect(() => validate(request(), reply(brainstormReply, { state: 'PLAN' }))).toThrowError('UNEXPECTED_REPLY_STATE');
  });

  it('3. plan phase rejects state=IDEAS symmetrically', () => {
    const req = request({ taskId: 'gpt6_collab_opt_20260918', requestId: 'gpt6-collab-opt-plan-1-fix1', iteration: 0, mode: 'plan' });
    expect(() => validate(req, reply(planReply, { state: 'IDEAS', iteration: 0 }))).toThrowError('UNEXPECTED_REPLY_STATE');
  });

  it('4. sources[].url must be a full https URL, not a repo-relative path', () => {
    const req = request({ taskId: 'gpt6_collab_opt_20260918', requestId: 'gpt6-collab-opt-plan-1', iteration: 0, mode: 'plan' });
    const rep = JSON.parse(reply(planReply, { mode: 'plan' }));
    rep.sources = [{ url: 'AGENTS.md', claim: 'readme' }];
    // NOTE: the installed 25478600289c dist wraps this as INVALID_REPLY_SCHEMA;
    // this ref propagates the raw zod message. Pin the branch behavior here and
    // re-pin when the wrapper lands upstream.
    expect(() => validate(req, JSON.stringify(rep))).toThrowError(/Invalid URL|INVALID_REPLY_SCHEMA/);
  });

  it('5. a single text field over 2000 chars is rejected', () => {
    const rep = JSON.parse(reply(brainstormReply, { summary: 'x'.repeat(2001) }));
    expect(() => validate(request(), JSON.stringify(rep))).toThrowError('INVALID_REPLY_SCHEMA');
  });

  it('6. duplicate JSON keys are rejected, not last-key-wins', () => {
    const body = '{"version":1,"state":"IDEAS","state":"PLAN"}';
    expect(() => validate(request(), body)).toThrowError('INVALID_REPLY_JSON_DUPLICATE_KEY');
  });

  it('7. fence-less raw JSON bodies are accepted (lane3 live shape)', () => {
    const raw = JSON.stringify(brainstormReply);
    const out = validate(request(), raw);
    expect(out.state).toBe('IDEAS');
  });

  it('8. replies over 64KiB are rejected wholesale', () => {
    const rep = JSON.parse(reply(brainstormReply, {}));
    rep.rationale = Array.from({ length: 40 }, (_, i) => `r${i} ` + 'x'.repeat(2000));
    const raw = JSON.stringify(rep);
    expect(raw.length).toBeGreaterThan(64 * 1024);
    expect(() => validate(request(), raw)).toThrowError('REPLY_TOO_LARGE');
  });

  it('9. each of the five bound fields is named when it mismatches', () => {
    for (const [field, wrong] of [
      ['taskId', 'other_task'],
      ['requestId', 'other-request'],
      ['conversationUrl', 'https://chatgpt.com/c/not-this-one'],
    ] as const) {
      try {
        validate(request(), reply(brainstormReply, { [field]: wrong }));
        expect.unreachable(`${field} mismatch should throw`);
      } catch (error) {
        expect((error as Error).message).toBe(`REPLY_MISMATCH_${field}`);
      }
    }
  });

  it('10. characterization: five-field match is per-request only — cross-round correlation, same-id payload conflict, and consumption idempotence are NOT_ESTABLISHED here (caller guarantees: A01/A02 owners)', () => {
    // Two receipts sharing taskId+iteration but carrying different requestIds
    // BOTH validate. The module intentionally does not dedupe rounds — callers
    // that correlate execution summaries on taskId+iteration alone will conflate
    // them (the 7-conflict audit class found on 2026-09-20). Correlate on
    // requestId, or record one execution summary per requestId.
    const a = validate(request(), reply(brainstormReply, {}));
    const b = validate(
      request({ requestId: 'gpt6loop-transport-opt-20260920-r2' }),
      reply(brainstormReply, { requestId: 'gpt6loop-transport-opt-20260920-r2' }),
    );
    expect(a.requestId).toBe('gpt6loop-transport-opt-20260920');
    expect(b.requestId).toBe('gpt6loop-transport-opt-20260920-r2');
  });
});

describe('planner-reply boundary precision (A00-R3)', () => {
  const base = {
    version: 1,
    taskId: 'gpt6loop_transport_20260920',
    requestId: 'gpt6loop-transport-opt-20260920',
    iteration: 3,
    conversationUrl: CONV,
    mode: 'brainstorm',
    state: 'IDEAS',
    rationale: ['r'],
    actions: ['a'],
    tests: ['t'],
    successCriteria: ['sc'],
    issues: [],
    sources: [{ url: 'https://example.com/e', claim: 'c' }],
  };

  it('2000 chars exactly is accepted; 2001 rejected (units: JS string chars)', () => {
    const ok = JSON.stringify({ ...base, summary: 's'.repeat(2000) });
    expect(validate(request(), ok).state).toBe('IDEAS');
    const bad = JSON.stringify({ ...base, summary: 's'.repeat(2001) });
    expect(() => validate(request(), bad)).toThrowError(/INVALID_REPLY_SCHEMA|Invalid URL|2000/);
  });

  it('mismatch varies one field at a time from the legal baseline', () => {
    for (const [field, wrong] of [
      ['iteration', 4],
      ['mode', 'review'],
    ] as const) {
      expect(() => validate(request(), reply(brainstormReply, { [field]: wrong })))
        .toThrowError(`REPLY_MISMATCH_${field}`);
    }
  });

  it('url family: https and WHATWG-normalized single-slash accepted; relative and http rejected', () => {
    const withUrl = (u: string) => {
      const rep = JSON.parse(JSON.stringify(brainstormReply));
      rep.sources = [{ url: u, claim: 'c' }];
      return JSON.stringify(rep);
    };
    expect(validate(request(), withUrl('https://example.com/a')).state).toBe('IDEAS');
    // https-only scheme enforced. WHATWG leniency: 'https:/example.com/a'
    // (single slash) NORMALIZES to a valid URL and is accepted — pinned as
    // actual semantics so the divergence is explicit.
    expect(validate(request(), withUrl('https:/example.com/a')).state).toBe('IDEAS');
    for (const bad of ['AGENTS.md', 'http://example.com/a']) {
      expect(() => validate(request(), withUrl(bad))).toThrowError();
    }
  });

  it('two contradictory complete blocks are rejected regardless of order', () => {
    const blockA = '```json\n' + JSON.stringify(brainstormReply) + '\n```';
    const blockB = '```json\n' + JSON.stringify({ ...brainstormReply, requestId: 'gpt6loop-transport-opt-20260920-r2' }) + '\n```';
    // Each block individually validates against its own request...
    expect(validate(request(), blockA).state).toBe('IDEAS');
    expect(validate(request({ requestId: 'gpt6loop-transport-opt-20260920-r2' }), blockB).state).toBe('IDEAS');
    // ...but combined they are one acceptance attempt and must fail (this ref
    // fails the body as invalid JSON; the installed dist yields
    // INVALID_REPLY_FENCE — both reject, neither picks a winner block).
    expect(() => validate(request(), blockA + '\n' + blockB)).toThrowError(/INVALID_REPLY_FENCE|INVALID_REPLY_JSON/);
    expect(() => validate(request(), blockB + '\n' + blockA)).toThrowError(/INVALID_REPLY_FENCE|INVALID_REPLY_JSON/);
  });

  it('old legal block followed by a truncated new block is rejected', () => {
    const good = '```json\n' + JSON.stringify(brainstormReply) + '\n```';
    expect(() => validate(request(), good + '\n```json\n{"version":1,"state":"')).toThrowError('INVALID_REPLY_FENCE');
  });

  it('64KiB limit units are utf-8 BYTES, not chars: CJK payload crosses the byte limit while the char count stays legal', () => {
    // Every per-field cap respected (rationale 30x<=2000 chars). CJK: raw.length
    // (utf-16 units) stays <=65536 while utf-8 bytes blow past 65536 -> the
    // byte limit fires (REPLY_TOO_LARGE). ASCII twin with the same char count
    // stays under -> validates. Proves the unit is utf-8 BYTES.
    const cjk = JSON.parse(JSON.stringify(base));
    cjk.summary = 's';
    cjk.rationale = Array.from({ length: 30 }, (_, i) => `项${i} ` + '测'.repeat(1985));
    const cjkRaw = JSON.stringify(cjk);
    expect(cjkRaw.length).toBeLessThanOrEqual(65536);
    expect(Buffer.byteLength(cjkRaw, 'utf8')).toBeGreaterThan(64 * 1024);
    expect(() => validate(request(), cjkRaw)).toThrowError('REPLY_TOO_LARGE');

    const ascii = JSON.parse(JSON.stringify(base));
    ascii.summary = 's';
    ascii.rationale = Array.from({ length: 30 }, (_, i) => `r${i} ` + 'x'.repeat(1985));
    const asciiRaw = JSON.stringify(ascii);
    expect(asciiRaw.length).toBeLessThanOrEqual(65536);
    expect(Buffer.byteLength(asciiRaw, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(validate(request(), asciiRaw).state).toBe('IDEAS');
  });
});

describe('planner-reply incident-family fixtures (A00-R2)', () => {
  it('old iteration reused with a different requestId still validates per-request (correlation stays caller-side)', () => {
    const oldRoundReq = request({ requestId: 'gpt6loop-transport-opt-20260920' });
    const newRoundReq = request({ requestId: 'gpt6loop-transport-opt-20260920-r2', iteration: 3 });
    expect(validate(oldRoundReq, reply(brainstormReply, {})).requestId).toBe('gpt6loop-transport-opt-20260920');
    expect(validate(newRoundReq, reply(brainstormReply, { requestId: 'gpt6loop-transport-opt-20260920-r2' })).requestId)
      .toBe('gpt6loop-transport-opt-20260920-r2');
  });

  it('same request replayed twice yields deep-equal results (stateless parse)', () => {
    const raw = reply(brainstormReply, {});
    expect(validate(request(), raw)).toEqual(validate(request(), raw));
  });

  it('same requestId with conflicting content still parses both (content conflict detection NOT_ESTABLISHED)', () => {
    const one = validate(request(), reply(brainstormReply, {}));
    const two = validate(request(), reply(brainstormReply, { summary: 'contradictory content' }));
    expect(one.summary).not.toBe(two.summary);
    // Caller must hash payloads (A01/A02 envelope) to detect this.
  });

  it('a single legal fenced block is accepted', () => {
    const fenced = '```json\n' + JSON.stringify(brainstormReply) + '\n```';
    expect(validate(request(), fenced).state).toBe('IDEAS');
  });
});
