#!/usr/bin/env node
// Local, atomic Skill activation only. No service, connector, config or session writes.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

function readSkill(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('SKILL_NOT_BOUNDED_REGULAR_FILE');
  return fs.readFileSync(file, 'utf8');
}

export function prepareUpdate(releaseDir, skillFile) {
  const release = fs.realpathSync(releaseDir);
  const source = readSkill(path.join(release, 'skill/SKILL.md'));
  if (!/^name: codex-with-chatgpt$/m.test(source)) throw new Error('WRONG_SKILL');
  for (const file of ['package.json', 'bin/c2c.js', 'dist/cli/index.js',
    'extension/manifest.json', 'extension/content.js', 'extension/service-worker.js']) {
    const target = path.join(release, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`RELEASE_FILE_MISSING:${file}`);
  }
  for (const match of source.matchAll(/__C2C_CHECKOUT__\/(docs\/[A-Za-z0-9./_-]+\.md)/g)) {
    if (!fs.statSync(path.join(release, match[1])).isFile()) throw new Error('MISSING_REFERENCE');
  }
  const help = execFileSync(process.execPath, [path.join(release, 'bin/c2c.js'), 'validate-reply', '--help'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!help.includes('--request') || !help.includes('--reply')) throw new Error('RELEASE_CLI_NOT_READY');
  return { expected: readSkill(skillFile), replacement: source.replaceAll('__C2C_CHECKOUT__', release) };
}

function stage(file, text, mode) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function replaceSkill({ skillFile, expected, replacement, backupRoot }) {
  if (path.basename(skillFile) !== 'SKILL.md') throw new Error('TARGET_MUST_BE_SKILL_MD');
  if (Buffer.byteLength(replacement) > 128 * 1024) throw new Error('SKILL_TOO_LARGE');
  const lock = `${skillFile}.update.lock`;
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  const pending = path.join(path.dirname(skillFile), `.SKILL-${randomUUID()}.tmp`);
  try {
    if (readSkill(skillFile) !== expected) throw new Error('INSTALLED_SKILL_CHANGED');
    if (expected === replacement) return { status: 'unchanged', backup: null };
    const backup = path.join(backupRoot, `update-${randomUUID()}`);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.chmodSync(backup, 0o700);
    stage(path.join(backup, 'previous.md'), expected, 0o600);
    stage(path.join(backup, 'installed.md'), replacement, 0o600);
    stage(pending, replacement, fs.statSync(skillFile).mode & 0o777);
    // Compare again immediately before rename; refuse to overwrite another writer.
    if (readSkill(skillFile) !== expected) throw new Error('INSTALLED_SKILL_CHANGED');
    fs.renameSync(pending, skillFile);
    return { status: 'updated', backup };
  } finally {
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

export function restoreSkill({ skillFile, backup, backupRoot }) {
  return replaceSkill({ skillFile, backupRoot,
    expected: readSkill(path.join(backup, 'installed.md')),
    replacement: readSkill(path.join(backup, 'previous.md')) });
}

function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { options.apply = true; continue; }
    if (!['--release', '--skill', '--backups', '--restore'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    options[args[i].slice(2)] = path.resolve(args[++i]);
  }
  if (!options.skill || !options.backups || Boolean(options.release) === Boolean(options.restore)) {
    throw new Error('Use --release DIR or --restore BACKUP, plus --skill FILE --backups DIR; dry-run by default, --apply to activate');
  }
  const prepared = options.restore ? {
    expected: readSkill(path.join(options.restore, 'installed.md')),
    replacement: readSkill(path.join(options.restore, 'previous.md')),
  } : prepareUpdate(options.release, options.skill);
  if (readSkill(options.skill) !== prepared.expected) throw new Error('INSTALLED_SKILL_CHANGED');
  const result = options.apply ? replaceSkill({ skillFile: options.skill, backupRoot: options.backups, ...prepared }) : { status: 'dry-run', changes: prepared.expected !== prepared.replacement };
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    // Child CLI output may include local paths or diagnostics; do not echo it.
    process.stderr.write(error && 'status' in error ? 'RELEASE_CLI_CHECK_FAILED\n' : `${error.message}\n`);
    process.exitCode = 2;
  }
}
