import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPlannerReply, checkPlannerReplyFiles } from '../src/execution/planner-check.js';

const request = { taskId: 'diagnostic', requestId: 'review-1', iteration: 1,
  conversationUrl: 'https://chatgpt.com/c/diagnostic-1', mode: 'review' };
const reply = { ...request, version: 1, state: 'PLAN', summary: 'Address the missing case',
  rationale: ['Missing coverage'], actions: ['Add boundary test'], tests: ['Run test'],
  successCriteria: ['Boundary case passes'], issues: [], sources: [] };
const expected = JSON.stringify(request);
const raw = JSON.stringify(reply);
const dirs: string[] = [];
function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-check-'));
  dirs.push(dir);
  const req = path.join(dir, 'request.json'), res = path.join(dir, 'reply.json');
  fs.writeFileSync(req, expected); fs.writeFileSync(res, raw);
  return { dir, req, res };
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('planner recovery diagnostics', () => {
  it('preserves valid reply behavior and never returns proposal contents', () => {
    expect(checkPlannerReply(expected, raw)).toEqual({ ok: true, authority: 'proposal-only',
      state: 'PLAN', taskId: 'diagnostic', requestId: 'review-1', iteration: 1, next: 'local-adoption-review' });
  });
  it('separates local request failure from a bad web reply', () => {
    expect(checkPlannerReply('{secret-invalid', raw)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST', next: 'repair-local-request' });
    expect(checkPlannerReply(expected, '{secret-invalid')).toMatchObject({ ok: false, reason: 'INVALID_REPLY_JSON', next: 'request-format-correction' });
  });
  it.each(['taskId', 'requestId', 'iteration', 'conversationUrl', 'mode'] as const)('does not recommend format repair for a mismatched %s', key => {
    const values = { taskId: 'other', requestId: 'stale', iteration: 0, conversationUrl: 'https://chatgpt.com/c/other', mode: 'plan' };
    expect(checkPlannerReply(expected, JSON.stringify({ ...reply, [key]: values[key] }))).toMatchObject({ ok: false, reason: `REPLY_MISMATCH_${key}`, next: 'inspect-conversation-and-round' });
  });
  it('keeps duplicate bindings distinct from fixable formatting', () => {
    const duplicate = raw.replace('"requestId":"review-1"', '"requestId":"stale","requestId":"review-1"');
    expect(checkPlannerReply(expected, duplicate)).toMatchObject({ ok: false, reason: 'INVALID_REPLY_JSON_DUPLICATE_KEY', next: 'inspect-ambiguous-reply' });
  });
  it('does not convert unfinished work into format retries', () => {
    expect(checkPlannerReply(expected, JSON.stringify({ ...reply, state: 'DONE' }))).toMatchObject({ ok: false, reason: 'DONE_HAS_UNRESOLVED_WORK', next: 'resolve-unfinished-work' });
  });
  it('does not expose rejected property names or values in diagnostics', () => {
    const secret = 'private-content-must-not-leave-checker';
    const result = checkPlannerReply(expected, JSON.stringify({ ...reply, [secret]: secret }));
    expect(result).toMatchObject({ ok: false, reason: 'INVALID_REPLY_SCHEMA', next: 'request-schema-correction' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('does not expose local filenames in unreadable-input diagnostics', () => {
    const { req, dir } = files();
    const result = checkPlannerReplyFiles(req, path.join(dir, 'private-secret-filename'));
    expect(result).toMatchObject({ ok: false, reason: 'INPUT_UNREADABLE' });
    expect(JSON.stringify(result)).not.toContain(dir);
    expect(JSON.stringify(result)).not.toContain('private-secret-filename');
  });
  it('rejects a directory or oversized regular file', () => {
    const { req, res, dir } = files();
    expect(checkPlannerReplyFiles(req, dir)).toMatchObject({ ok: false, reason: 'INPUT_NOT_BOUNDED_FILE' });
    fs.writeFileSync(res, 'x'.repeat(65537));
    expect(checkPlannerReplyFiles(req, res)).toMatchObject({ ok: false, reason: 'INPUT_NOT_BOUNDED_FILE' });
  });
  it('enforces the read ceiling even when metadata reports a smaller file', () => {
    const { req, res } = files();
    fs.writeFileSync(res, 'x'.repeat(100000));
    const stat = fs.statSync(req);
    vi.spyOn(fs, 'fstatSync').mockReturnValue(stat);
    expect(checkPlannerReplyFiles(req, res)).toMatchObject({ ok: false, reason: 'INPUT_NOT_BOUNDED_FILE' });
  });
  it.skipIf(process.platform === 'win32')('rejects an unopened FIFO without waiting for a writer', () => {
    const { req, dir } = files();
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(checkPlannerReplyFiles(req, fifo)).toMatchObject({ ok: false, reason: 'INPUT_NOT_BOUNDED_FILE' });
  });
  it('reads ordinary files successfully without changing them', () => {
    const { req, res } = files();
    expect(checkPlannerReplyFiles(req, res)).toMatchObject({ ok: true });
    expect(fs.readFileSync(req, 'utf8')).toBe(expected);
    expect(fs.readFileSync(res, 'utf8')).toBe(raw);
  });
});
