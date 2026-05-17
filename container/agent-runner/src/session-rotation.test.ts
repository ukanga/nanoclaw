import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getAutoCompactThresholdBytes,
  liveSessionBytes,
  shouldRotateSession,
  transcriptPath,
} from './session-rotation.js';

const ORIGINAL_THRESHOLD = process.env.AUTO_COMPACT_THRESHOLD_BYTES;
const ORIGINAL_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR;

afterEach(() => {
  if (ORIGINAL_THRESHOLD === undefined) delete process.env.AUTO_COMPACT_THRESHOLD_BYTES;
  else process.env.AUTO_COMPACT_THRESHOLD_BYTES = ORIGINAL_THRESHOLD;
  if (ORIGINAL_PROJECTS_DIR === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
  else process.env.CLAUDE_PROJECTS_DIR = ORIGINAL_PROJECTS_DIR;
});

describe('getAutoCompactThresholdBytes', () => {
  it('defaults to 500_000 when env var is unset', () => {
    delete process.env.AUTO_COMPACT_THRESHOLD_BYTES;
    expect(getAutoCompactThresholdBytes()).toBe(500_000);
  });

  it('honours a valid positive env value', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '250000';
    expect(getAutoCompactThresholdBytes()).toBe(250_000);
  });

  it('falls back to default when env value is 0', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '0';
    expect(getAutoCompactThresholdBytes()).toBe(500_000);
  });

  it('falls back to default when env value is negative', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '-100';
    expect(getAutoCompactThresholdBytes()).toBe(500_000);
  });

  it('falls back to default when env value is non-numeric', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = 'huge';
    expect(getAutoCompactThresholdBytes()).toBe(500_000);
  });

  it('resolves env lazily — change without restart is honoured', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '100';
    expect(getAutoCompactThresholdBytes()).toBe(100);
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '200';
    expect(getAutoCompactThresholdBytes()).toBe(200);
  });
});

describe('transcriptPath', () => {
  beforeEach(() => {
    process.env.CLAUDE_PROJECTS_DIR = '/test-projects';
  });

  it('derives the SDK project key from a single-segment cwd', () => {
    expect(transcriptPath('sess-1', '/workspace')).toBe('/test-projects/-workspace/sess-1.jsonl');
  });

  it('derives the SDK project key from a multi-segment cwd', () => {
    expect(transcriptPath('sess-2', '/workspace/agent')).toBe('/test-projects/-workspace-agent/sess-2.jsonl');
  });

  it('strips a trailing slash on cwd', () => {
    expect(transcriptPath('sess-3', '/workspace/agent/')).toBe('/test-projects/-workspace-agent/sess-3.jsonl');
  });

  it('defaults to /home/node/.claude/projects when env unset', () => {
    delete process.env.CLAUDE_PROJECTS_DIR;
    expect(transcriptPath('sess-4', '/workspace/agent')).toBe(
      '/home/node/.claude/projects/-workspace-agent/sess-4.jsonl',
    );
  });
});

describe('liveSessionBytes', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-'));
    file = path.join(tmpDir, 't.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns total bytes when no compact_boundary is present', () => {
    fs.writeFileSync(file, '{"type":"user"}\n{"type":"assistant"}\n');
    const total = fs.statSync(file).size;
    expect(liveSessionBytes(file, total)).toBe(total);
  });

  it('returns 0 when the boundary line has no trailing newline', () => {
    fs.writeFileSync(file, '{"type":"system","subtype":"compact_boundary"}');
    const total = fs.statSync(file).size;
    expect(liveSessionBytes(file, total)).toBe(0);
  });

  it('returns bytes after the only compact_boundary', () => {
    const tail = '{"type":"user","content":"after"}\n';
    fs.writeFileSync(file, '{"type":"system","subtype":"compact_boundary"}\n' + tail);
    const total = fs.statSync(file).size;
    expect(liveSessionBytes(file, total)).toBe(Buffer.byteLength(tail, 'utf-8'));
  });

  it('returns bytes after the LAST compact_boundary when multiple are present', () => {
    const tail = '{"after-second":true}\n';
    fs.writeFileSync(
      file,
      '{"subtype":"compact_boundary"}\n' +
        '{"type":"user","content":"between"}\n' +
        '{"subtype":"compact_boundary"}\n' +
        tail,
    );
    const total = fs.statSync(file).size;
    expect(liveSessionBytes(file, total)).toBe(Buffer.byteLength(tail, 'utf-8'));
  });
});

describe('shouldRotateSession', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-'));
    process.env.CLAUDE_PROJECTS_DIR = tmpDir;
    projectDir = path.join(tmpDir, '-workspace-rotation-test');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when the transcript file is missing', () => {
    expect(shouldRotateSession('missing-session', '/workspace/rotation-test')).toBe(false);
  });

  it('returns true when live bytes exceed the threshold', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '100';
    fs.writeFileSync(path.join(projectDir, 'sess-over.jsonl'), 'x'.repeat(200));
    expect(shouldRotateSession('sess-over', '/workspace/rotation-test')).toBe(true);
  });

  it('returns false when live bytes are under the threshold', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '1000';
    fs.writeFileSync(path.join(projectDir, 'sess-under.jsonl'), 'x'.repeat(50));
    expect(shouldRotateSession('sess-under', '/workspace/rotation-test')).toBe(false);
  });

  it('measures live bytes (post-boundary), not total file size', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '200';
    const head = 'x'.repeat(500);
    const tail = 'y'.repeat(50);
    fs.writeFileSync(path.join(projectDir, 'sess-boundary.jsonl'), head + '\n{"subtype":"compact_boundary"}\n' + tail);
    // Total > threshold, but live tail (50) is under.
    expect(shouldRotateSession('sess-boundary', '/workspace/rotation-test')).toBe(false);
  });

  it('returns true when live bytes after a boundary exceed the threshold', () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '50';
    fs.writeFileSync(
      path.join(projectDir, 'sess-post-boundary.jsonl'),
      '{"subtype":"compact_boundary"}\n' + 'y'.repeat(100),
    );
    expect(shouldRotateSession('sess-post-boundary', '/workspace/rotation-test')).toBe(true);
  });
});
