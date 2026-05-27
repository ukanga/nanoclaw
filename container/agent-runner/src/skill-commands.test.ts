import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { resolveSkillCommandFallback } from './skill-commands.js';

function makeSkillsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
}

describe('resolveSkillCommandFallback', () => {
  it('loads matching container skill instructions for slash commands', () => {
    const skillsDir = makeSkillsDir();
    fs.mkdirSync(path.join(skillsDir, 'status'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'status', 'SKILL.md'), '# /status\n\nRun checks.');

    const fallback = resolveSkillCommandFallback('/status please', skillsDir);

    expect(fallback?.command).toBe('/status');
    expect(fallback?.skillName).toBe('status');
    expect(fallback?.prompt).toContain('provider_fallback="true"');
    expect(fallback?.prompt).toContain('# /status');
    expect(fallback?.prompt).toContain('<user-command>/status please</user-command>');
  });

  it('returns null when the skill is not installed', () => {
    const skillsDir = makeSkillsDir();
    expect(resolveSkillCommandFallback('/missing', skillsDir)).toBeNull();
  });

  it('rejects unsafe command names', () => {
    const skillsDir = makeSkillsDir();
    fs.mkdirSync(path.join(skillsDir, 'status'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'status', 'SKILL.md'), '# /status');

    expect(resolveSkillCommandFallback('/../status', skillsDir)).toBeNull();
    expect(resolveSkillCommandFallback('/Status', skillsDir)?.skillName).toBe('status');
  });

  it('ignores normal chat text', () => {
    const skillsDir = makeSkillsDir();
    expect(resolveSkillCommandFallback('status please', skillsDir)).toBeNull();
  });
});
