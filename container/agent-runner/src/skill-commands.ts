import fs from 'fs';
import path from 'path';

const DEFAULT_SKILLS_DIR = '/app/skills';
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface SkillCommandFallback {
  command: string;
  skillName: string;
  prompt: string;
}

export function resolveSkillCommandFallback(text: string, skillsDir = DEFAULT_SKILLS_DIR): SkillCommandFallback | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const [command] = trimmed.split(/\s+/, 1);
  const skillName = command.slice(1).toLowerCase();
  if (!SKILL_NAME_RE.test(skillName)) return null;

  const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
  if (!isPathInside(skillsDir, skillPath) || !fs.existsSync(skillPath)) return null;

  const skill = fs.readFileSync(skillPath, 'utf-8');
  return {
    command,
    skillName,
    prompt: [
      `<skill-command name="${escapeXml(command)}" provider_fallback="true">`,
      'The user invoked a NanoClaw skill, but this provider does not have native Claude Code slash-command support.',
      'Follow the SKILL.md instructions below as the governing instructions for this turn. If the skill asks you to run checks, run them using the available tools and report the result.',
      '',
      `<user-command>${escapeXml(trimmed)}</user-command>`,
      '',
      `<skill-instructions path="${escapeXml(skillPath)}">`,
      skill,
      '</skill-instructions>',
      '</skill-command>',
    ].join('\n'),
  };
}

function isPathInside(baseDir: string, candidate: string): boolean {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
