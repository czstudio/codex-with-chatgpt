import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone deployment script intentionally has no TS build dependency.
import { prepareUpdate, replaceSkill, restoreSkill } from '../scripts/update-skill.mjs';
import { cleanup, makeTmpDir } from './helpers.js';

const roots: string[] = [];
function fixture() {
  const root = makeTmpDir('skill-update'); roots.push(root);
  const skillFile = path.join(root, 'SKILL.md');
  fs.writeFileSync(skillFile, 'previous version');
  return { root, skillFile, backupRoot: path.join(root, 'backups'), expected: 'previous version', replacement: 'tested version' };
}
afterEach(() => { vi.restoreAllMocks(); while (roots.length) cleanup(roots.pop()!); });

describe('atomic Skill update', () => {
  it('rejects an incomplete release before running its CLI or replacing the Skill', () => {
    const f = fixture(); const release = path.join(f.root, 'release');
    fs.mkdirSync(path.join(release, 'skill'), { recursive: true });
    fs.writeFileSync(path.join(release, 'skill/SKILL.md'), '---\nname: codex-with-chatgpt\n---\nCandidate');
    expect(() => prepareUpdate(release, f.skillFile)).toThrow('RELEASE_FILE_MISSING:package.json');
    expect(fs.readFileSync(f.skillFile, 'utf8')).toBe(f.expected);
  });
  it('backs up exact bytes, activates, and restores only the version it installed', () => {
    const f = fixture(); const result = replaceSkill(f);
    expect(fs.readFileSync(f.skillFile, 'utf8')).toBe(f.replacement);
    expect(fs.readFileSync(path.join(result.backup, 'previous.md'), 'utf8')).toBe(f.expected);
    expect(fs.statSync(path.join(result.backup, 'previous.md')).mode & 0o777).toBe(0o600);
    restoreSkill({ ...f, backup: result.backup });
    expect(fs.readFileSync(f.skillFile, 'utf8')).toBe(f.expected);
  });
  it('leaves the active file unchanged when activation fails before rename', () => {
    const f = fixture();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated disk error'); });
    expect(() => replaceSkill(f)).toThrow('simulated disk error');
    expect(fs.readFileSync(f.skillFile, 'utf8')).toBe(f.expected);
    expect(fs.readdirSync(f.root).filter(x => x.includes('.tmp') || x.includes('.lock'))).toEqual([]);
  });
  it('refuses to overwrite concurrent changes during activation or rollback', () => {
    const f = fixture();
    expect(() => replaceSkill({ ...f, expected: 'stale' })).toThrow('INSTALLED_SKILL_CHANGED');
    const installed = replaceSkill(f);
    fs.writeFileSync(f.skillFile, 'another owner changed this');
    expect(() => restoreSkill({ ...f, backup: installed.backup })).toThrow('INSTALLED_SKILL_CHANGED');
    expect(fs.readFileSync(f.skillFile, 'utf8')).toBe('another owner changed this');
  });
  it('does nothing for identical content and respects another updater lock', () => {
    const f = fixture();
    expect(replaceSkill({ ...f, replacement: f.expected }).status).toBe('unchanged');
    expect(fs.existsSync(f.backupRoot)).toBe(false);
    fs.writeFileSync(f.skillFile + '.update.lock', 'other updater');
    expect(() => replaceSkill(f)).toThrow();
    expect(fs.readFileSync(f.skillFile + '.update.lock', 'utf8')).toBe('other updater');
  });
  it('refuses symlink targets rather than modifying the linked file', () => {
    const f = fixture(); const other = path.join(f.root, 'other');
    fs.renameSync(f.skillFile, other); fs.symlinkSync(other, f.skillFile);
    expect(() => replaceSkill(f)).toThrow('SKILL_NOT_BOUNDED_REGULAR_FILE');
    expect(fs.readFileSync(other, 'utf8')).toBe(f.expected);
  });
  it('stops the first-install entrypoint before touching an existing installation', () => {
    const f = fixture(); const skillsRoot = path.join(f.root, 'skills');
    const installed = path.join(skillsRoot, 'codex-with-chatgpt');
    fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'SKILL.md'), 'active');
    const result = spawnSync('/bin/bash', ['scripts/install.sh'], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8',
      env: { ...process.env, CODEX_SKILLS_DIR: skillsRoot, C2C_INSTALL_DIR: path.join(f.root, 'new-checkout'), PATH: '/nonexistent' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Existing installation');
    expect(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8')).toBe('active');
    expect(fs.existsSync(path.join(f.root, 'new-checkout'))).toBe(false);
  });

});
