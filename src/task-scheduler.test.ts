import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  runAttachmentCleanup,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe('runAttachmentCleanup', () => {
  let groupsDir: string;
  const ageDay = 24 * 60 * 60 * 1000;

  function makeFile(rel: string, mtimeMs: number): string {
    const full = path.join(groupsDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
    return full;
  }

  beforeEach(() => {
    groupsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'attach-cleanup-test-'),
    );
    process.env.NANOCLAW_GROUPS_DIR = groupsDir;
    delete process.env.ATTACHMENT_RETENTION_DAYS;
  });

  afterEach(() => {
    delete process.env.NANOCLAW_GROUPS_DIR;
    delete process.env.ATTACHMENT_RETENTION_DAYS;
    fs.rmSync(groupsDir, { recursive: true, force: true });
  });

  it('deletes inbox/outbox files older than the retention window', async () => {
    const now = Date.now();
    const old = makeFile('team-a/inbox/old.pdf', now - 40 * ageDay);
    const fresh = makeFile('team-a/inbox/fresh.pdf', now - 5 * ageDay);
    const oldOut = makeFile('team-a/outbox/old.xlsx', now - 35 * ageDay);

    await runAttachmentCleanup();

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldOut)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('respects ATTACHMENT_RETENTION_DAYS override', async () => {
    process.env.ATTACHMENT_RETENTION_DAYS = '3';
    const now = Date.now();
    const file = makeFile('team-a/inbox/short-lived.pdf', now - 5 * ageDay);

    await runAttachmentCleanup();

    expect(fs.existsSync(file)).toBe(false);
  });

  it('skips groups that have no inbox/outbox', async () => {
    fs.mkdirSync(path.join(groupsDir, 'no-attachments'), { recursive: true });
    await expect(runAttachmentCleanup()).resolves.toBeUndefined();
  });

  it('does not touch subdirectories or non-files', async () => {
    fs.mkdirSync(path.join(groupsDir, 'team-a/inbox/nested'), {
      recursive: true,
    });
    const old = makeFile(
      'team-a/inbox/nested/should-stay.pdf',
      Date.now() - 60 * ageDay,
    );
    await runAttachmentCleanup();
    expect(fs.existsSync(old)).toBe(true);
  });

  it('is a no-op when the groups dir is missing', async () => {
    delete process.env.NANOCLAW_GROUPS_DIR;
    process.env.NANOCLAW_GROUPS_DIR = path.join(groupsDir, 'does-not-exist');
    await expect(runAttachmentCleanup()).resolves.toBeUndefined();
  });
});
