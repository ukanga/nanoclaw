import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAutoCompactThresholdBytes,
  liveSessionBytes,
  sessionFilePath,
} from './session-files.js';

describe('session-files', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-files-test-'));
    process.env.NANOCLAW_PROJECT_ROOT = projectRoot;
    delete process.env.AUTO_COMPACT_THRESHOLD_BYTES;
  });

  afterEach(() => {
    delete process.env.NANOCLAW_PROJECT_ROOT;
    delete process.env.AUTO_COMPACT_THRESHOLD_BYTES;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('sessionFilePath', () => {
    it('builds the per-group session jsonl path under NANOCLAW_PROJECT_ROOT', () => {
      const p = sessionFilePath('team-x', 'sess-1');
      expect(p).toBe(
        path.join(
          projectRoot,
          'data',
          'sessions',
          'team-x',
          '.claude',
          'projects',
          '-workspace-group',
          'sess-1.jsonl',
        ),
      );
    });
  });

  describe('getAutoCompactThresholdBytes', () => {
    it('returns 500_000 by default', () => {
      expect(getAutoCompactThresholdBytes()).toBe(500_000);
    });

    it('honours AUTO_COMPACT_THRESHOLD_BYTES when valid', () => {
      process.env.AUTO_COMPACT_THRESHOLD_BYTES = '12345';
      expect(getAutoCompactThresholdBytes()).toBe(12345);
    });

    it('falls back to default for invalid values', () => {
      process.env.AUTO_COMPACT_THRESHOLD_BYTES = 'not-a-number';
      expect(getAutoCompactThresholdBytes()).toBe(500_000);

      process.env.AUTO_COMPACT_THRESHOLD_BYTES = '0';
      expect(getAutoCompactThresholdBytes()).toBe(500_000);

      process.env.AUTO_COMPACT_THRESHOLD_BYTES = '-100';
      expect(getAutoCompactThresholdBytes()).toBe(500_000);
    });
  });

  describe('liveSessionBytes', () => {
    function makeSessionFile(content: string): string {
      const dir = path.join(
        projectRoot,
        'data',
        'sessions',
        'heavy',
        '.claude',
        'projects',
        '-workspace-group',
      );
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'sess.jsonl');
      fs.writeFileSync(file, content);
      return file;
    }

    it('returns total bytes when no compact_boundary marker is present', () => {
      const file = makeSessionFile('x'.repeat(1000));
      expect(liveSessionBytes(file, 1000)).toBe(1000);
    });

    it('returns only the post-boundary bytes when a compact_boundary marker is present', () => {
      const preCompact = 'x'.repeat(700_000) + '\n';
      const boundary =
        '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}\n';
      const summary = '{"type":"user","message":{"content":"summary"}}\n';
      const postCompact = 'y'.repeat(5_000) + '\n';
      const file = makeSessionFile(
        preCompact + boundary + summary + postCompact,
      );
      const totalBytes = fs.statSync(file).size;
      expect(totalBytes).toBeGreaterThan(700_000);
      expect(liveSessionBytes(file, totalBytes)).toBeLessThan(10_000);
    });

    it('returns 0 when the boundary marker is the last thing in the file (no newline after)', () => {
      const preCompact = 'x'.repeat(100) + '\n';
      const boundary =
        '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}';
      const file = makeSessionFile(preCompact + boundary);
      const totalBytes = fs.statSync(file).size;
      expect(liveSessionBytes(file, totalBytes)).toBe(0);
    });
  });
});
