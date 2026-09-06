// Reproducible local behavior comparison. No browser, provider or production-state access.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as current from '../src/execution/records.js';
import { validatePlannerReply } from '../src/execution/planner-reply.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(root, '.tooling', 'loop-comparison-'));
async function historical(ref: string, files: string[]) {
  const source = path.join(tmp, ref);
  for (const file of files) {
    const data = execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, maxBuffer: 1024 * 1024 });
    const target = path.join(source, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  }
  return source;
}
const originalRoot = await historical('7f190d0', ['src/execution/records.ts', 'src/config/paths.ts']);
const priorRoot = await historical('88ff25b', ['src/execution/records.ts', 'src/config/paths.ts', 'src/execution/planner-reply.ts']);
const original = await import(pathToFileURL(path.join(originalRoot, 'src/execution/records.ts')).href) as typeof current;
const prior = await import(pathToFileURL(path.join(priorRoot, 'src/execution/records.ts')).href) as typeof current;
const priorPlanner = await import(pathToFileURL(path.join(priorRoot, 'src/execution/planner-reply.ts')).href);
const results: Array<{ case: string; comparedWith: string; expected: boolean; before: boolean; after: boolean }> = [];
const execution = { taskId: 'demo', iteration: 1, changedFiles: 1, tests: '1 passed', exitStatus: 'ok', timestamp: '2026-09-05T00:00:00Z' };
const done = { kind: 'checkpoint' as const, taskId: 'demo', iteration: 1, state: 'DONE', summary: 'reviewed', knownIssues: [] as string[], nextExpectedStep: 'report', timestamp: '2026-09-05T00:01:00Z' };
const cases = [
  { name: 'valid completion', expected: true, records: [execution, done] },
  { name: 'missing test evidence', expected: false, records: [{ ...execution, tests: '' }, done] },
  { name: 'unresolved issue completion', expected: false, records: [execution, { ...done, knownIssues: ['not done'] }] },
  { name: 'DONE before execution', expected: false, records: [done, execution] },
  { name: 'obsolete iteration completion', expected: false, records: [execution, done, { ...execution, iteration: 2, exitStatus: 'failed' }] },
];
for (const item of cases) {
  process.env.C2C_STATE_DIR = fs.mkdtempSync(path.join(tmp, 'state-'));
  // Identical audit bytes are presented to both versions.
  for (const record of item.records) current.appendAuditRecord('ws', record);
  results.push({ case: item.name, comparedWith: '7f190d0', expected: item.expected,
    before: original.completionEvidence('ws', 'demo', 1).pass,
    after: current.completionEvidence('ws', 'demo', 1).pass });
}
function replay(api: typeof current): boolean {
  process.env.C2C_STATE_DIR = fs.mkdtempSync(path.join(tmp, 'replay-'));
  api.appendExecutionRecord('ws', execution);
  try { api.appendExecutionRecord('ws', Object.fromEntries(Object.entries(execution).reverse()) as typeof execution); return true; } catch { return false; }
}
results.push({ case: 'identical recovery with reordered fields', comparedWith: '88ff25b', expected: true, before: replay(prior), after: replay(current) });
const request = { taskId: 'demo', requestId: 'review-1', iteration: 1, conversationUrl: 'https://chatgpt.com/c/demo-123', mode: 'review' as const };
const reply = JSON.stringify({ ...request, version: 1, state: 'DONE', summary: 'reviewed', rationale: [], actions: [], tests: ['1 passed'], successCriteria: ['sample goal met'], issues: [], sources: [] });
function accepts(check: typeof validatePlannerReply, raw: string): boolean { try { check(raw, request); return true; } catch { return false; } }
for (const item of [
  { name: 'standard complete reply', expected: true, raw: reply },
  { name: 'complete CRLF fenced reply', expected: true, raw: `\`\`\`json\r\n${reply}\r\n\`\`\`` },
  { name: 'contradictory duplicate request ID', expected: false, raw: reply.replace('"requestId":"review-1"', '"requestId":"old","requestId":"review-1"') },
]) results.push({ case: item.name, comparedWith: '88ff25b', expected: item.expected,
  before: accepts(priorPlanner.validatePlannerReply, item.raw), after: accepts(validatePlannerReply, item.raw) });
const report = { authority: 'offline-behavior-comparison', results,
  beforeCorrect: results.filter(x => x.before === x.expected).length,
  afterCorrect: results.filter(x => x.after === x.expected).length,
  total: results.length, regressions: results.filter(x => x.before === x.expected && x.after !== x.expected).length };
fs.writeFileSync(path.join(tmp, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Artifact: ${path.join(tmp, 'report.json')}`);
if (report.afterCorrect !== report.total || report.regressions) process.exitCode = 1;
