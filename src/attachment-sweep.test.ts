/**
 * Tests for attachment TTL sweep. Pure helpers tested in isolation; the
 * per-session walker against a real tmpdir; the loop with fake timers.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RETENTION_DAYS,
  INITIAL_DELAY_MS,
  SWEEP_INTERVAL_MS,
  _resetForTests,
  attachmentRetentionMs,
  isFileExpired,
  runAttachmentSweep,
  startAttachmentSweep,
  stopAttachmentSweep,
  sweepSessionAttachments,
} from './attachment-sweep.js';

// vi.mock is hoisted above the imports — keep this literal inline. The
// matching constant below MUST stay in sync.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-attachment-sweep-test' };
});

const TEST_DIR = '/tmp/nanoclaw-attachment-sweep-test';

function freshTree(): string {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  return TEST_DIR;
}

function touchFile(p: string, ageMs: number, contents = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(p, t, t);
}

describe('isFileExpired', () => {
  it('returns true for a file whose mtime is older than cutoff', () => {
    const stat = { isFile: () => true, mtimeMs: 1_000 } as fs.Stats;
    expect(isFileExpired(stat, 5_000)).toBe(true);
  });

  it('returns false for a fresh file', () => {
    const stat = { isFile: () => true, mtimeMs: 10_000 } as fs.Stats;
    expect(isFileExpired(stat, 5_000)).toBe(false);
  });

  it('returns false for non-files (dirs, symlinks)', () => {
    const stat = { isFile: () => false, mtimeMs: 0 } as fs.Stats;
    expect(isFileExpired(stat, 5_000)).toBe(false);
  });
});

describe('attachmentRetentionMs', () => {
  const originalEnv = process.env.ATTACHMENT_RETENTION_DAYS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ATTACHMENT_RETENTION_DAYS;
    else process.env.ATTACHMENT_RETENTION_DAYS = originalEnv;
  });

  it('defaults to DEFAULT_RETENTION_DAYS when unset', () => {
    delete process.env.ATTACHMENT_RETENTION_DAYS;
    expect(attachmentRetentionMs()).toBe(DEFAULT_RETENTION_DAYS * 86_400_000);
  });

  it('uses ATTACHMENT_RETENTION_DAYS env override', () => {
    process.env.ATTACHMENT_RETENTION_DAYS = '7';
    expect(attachmentRetentionMs()).toBe(7 * 86_400_000);
  });

  it('falls back to default on non-numeric input', () => {
    process.env.ATTACHMENT_RETENTION_DAYS = 'banana';
    expect(attachmentRetentionMs()).toBe(DEFAULT_RETENTION_DAYS * 86_400_000);
  });

  it('falls back to default on zero or negative input (v1 parity)', () => {
    process.env.ATTACHMENT_RETENTION_DAYS = '0';
    expect(attachmentRetentionMs()).toBe(DEFAULT_RETENTION_DAYS * 86_400_000);
    process.env.ATTACHMENT_RETENTION_DAYS = '-3';
    expect(attachmentRetentionMs()).toBe(DEFAULT_RETENTION_DAYS * 86_400_000);
  });
});

describe('sweepSessionAttachments', () => {
  beforeEach(freshTree);
  afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

  function sessionPath(...rest: string[]): string {
    return path.join(TEST_DIR, 'v2-sessions', 'ag-1', 'sess-1', ...rest);
  }

  const SEVEN_DAYS = 7 * 86_400_000;
  const ONE_HOUR = 60 * 60 * 1000;

  it('returns zeros when sessionDir is missing', () => {
    const res = sweepSessionAttachments(sessionPath(), Date.now() - SEVEN_DAYS);
    expect(res).toEqual({ deleted: 0, bytes: 0 });
  });

  it('deletes expired inbox files and leaves fresh ones intact', () => {
    const oldFile = sessionPath('inbox', 'msg-1', 'old.jpg');
    const freshFile = sessionPath('inbox', 'msg-2', 'fresh.jpg');
    touchFile(oldFile, SEVEN_DAYS + ONE_HOUR, 'old');
    touchFile(freshFile, ONE_HOUR, 'fresh');

    const cutoff = Date.now() - SEVEN_DAYS;
    const res = sweepSessionAttachments(sessionPath(), cutoff);

    expect(res.deleted).toBe(1);
    expect(res.bytes).toBe(3);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it('deletes expired outbox files', () => {
    const oldFile = sessionPath('outbox', 'msg-out-1', 'stale.pdf');
    touchFile(oldFile, SEVEN_DAYS + ONE_HOUR);
    const res = sweepSessionAttachments(sessionPath(), Date.now() - SEVEN_DAYS);
    expect(res.deleted).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('removes an empty messageId subdir after pruning all files', () => {
    const oldFile = sessionPath('inbox', 'msg-1', 'a.jpg');
    touchFile(oldFile, SEVEN_DAYS + ONE_HOUR);

    sweepSessionAttachments(sessionPath(), Date.now() - SEVEN_DAYS);

    expect(fs.existsSync(sessionPath('inbox', 'msg-1'))).toBe(false);
    // The inbox/ root itself is left in place — initSessionFolder owns it.
    expect(fs.existsSync(sessionPath('inbox'))).toBe(true);
  });

  it('keeps a messageId subdir when a fresh sibling still lives in it', () => {
    const oldFile = sessionPath('inbox', 'msg-mixed', 'old.jpg');
    const freshFile = sessionPath('inbox', 'msg-mixed', 'fresh.jpg');
    touchFile(oldFile, SEVEN_DAYS + ONE_HOUR);
    touchFile(freshFile, ONE_HOUR);

    sweepSessionAttachments(sessionPath(), Date.now() - SEVEN_DAYS);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    expect(fs.existsSync(sessionPath('inbox', 'msg-mixed'))).toBe(true);
  });

  it('tolerates a missing inbox or outbox subdir', () => {
    // Only outbox exists; inbox is missing.
    const oldFile = sessionPath('outbox', 'msg-out', 'stale.bin');
    touchFile(oldFile, SEVEN_DAYS + ONE_HOUR);

    const res = sweepSessionAttachments(sessionPath(), Date.now() - SEVEN_DAYS);
    expect(res.deleted).toBe(1);
  });
});

describe('runAttachmentSweep', () => {
  beforeEach(freshTree);
  afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

  it('walks every <agentGroup>/<session> directory under the sessions root', async () => {
    const SEVEN_DAYS = 7 * 86_400_000;
    process.env.ATTACHMENT_RETENTION_DAYS = '7';

    const stalePaths = [
      [TEST_DIR, 'v2-sessions', 'ag-A', 'sess-A1', 'inbox', 'msg', 'a.jpg'],
      [TEST_DIR, 'v2-sessions', 'ag-A', 'sess-A2', 'outbox', 'msg', 'b.pdf'],
      [TEST_DIR, 'v2-sessions', 'ag-B', 'sess-B1', 'inbox', 'msg', 'c.bin'],
    ];
    for (const parts of stalePaths) {
      touchFile(path.join(...parts), SEVEN_DAYS + 60_000);
    }

    await runAttachmentSweep();

    for (const parts of stalePaths) {
      expect(fs.existsSync(path.join(...parts))).toBe(false);
    }

    delete process.env.ATTACHMENT_RETENTION_DAYS;
  });

  it('is a no-op when the sessions root is missing', async () => {
    fs.rmSync(path.join(TEST_DIR, 'v2-sessions'), { recursive: true, force: true });
    await expect(runAttachmentSweep()).resolves.toBeUndefined();
  });

  it('ignores stray non-directory entries under the sessions root', async () => {
    const sessionsRoot = path.join(TEST_DIR, 'v2-sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, '.DS_Store'), 'junk');
    await expect(runAttachmentSweep()).resolves.toBeUndefined();
  });
});

describe('attachment sweep loop', () => {
  beforeEach(() => {
    freshTree();
    _resetForTests();
  });
  afterEach(() => {
    stopAttachmentSweep();
    _resetForTests();
    vi.useRealTimers();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('first runs after INITIAL_DELAY_MS, then every SWEEP_INTERVAL_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const SEVEN_DAYS = 7 * 86_400_000;
    process.env.ATTACHMENT_RETENTION_DAYS = '7';

    const target = path.join(TEST_DIR, 'v2-sessions', 'ag', 'sess', 'inbox', 'm', 'old.jpg');
    touchFile(target, SEVEN_DAYS + 60_000);

    startAttachmentSweep();
    expect(fs.existsSync(target)).toBe(true); // nothing yet

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(fs.existsSync(target)).toBe(false); // first sweep ran

    // Drop another stale file and confirm the next tick collects it.
    touchFile(target, SEVEN_DAYS + 60_000);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(fs.existsSync(target)).toBe(false);

    delete process.env.ATTACHMENT_RETENTION_DAYS;
  });

  it('start is idempotent', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    startAttachmentSweep();
    // Second call must be a no-op — no second loop should be scheduled.
    expect(() => startAttachmentSweep()).not.toThrow();
  });
});
