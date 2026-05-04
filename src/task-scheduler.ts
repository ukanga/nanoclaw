import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllSessions,
  getAllTasks,
  getDueTasks,
  getRouterState,
  getTaskById,
  logTaskRun,
  setRouterState,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

// ---------------------------------------------------------------------------
// Attachment cleanup
// ---------------------------------------------------------------------------

const ATTACHMENT_SUBDIRS = ['inbox', 'outbox'];
const ATTACHMENT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_CLEANUP_INITIAL_DELAY_MS = 60_000;

function getAttachmentRetentionMs(): number {
  const raw = process.env.ATTACHMENT_RETENTION_DAYS;
  const days = raw ? parseInt(raw, 10) : 30;
  const safe = Number.isFinite(days) && days > 0 ? days : 30;
  return safe * 24 * 60 * 60 * 1000;
}

function getAttachmentBaseDir(): string {
  return process.env.NANOCLAW_GROUPS_DIR ?? GROUPS_DIR;
}

/**
 * Delete files in every `groups/*\/inbox/` and `groups/*\/outbox/`
 * older than ATTACHMENT_RETENTION_DAYS (default 30). Logs per-group
 * counts when something gets pruned. Safe to run on a missing tree.
 */
export async function runAttachmentCleanup(): Promise<void> {
  const baseDir = getAttachmentBaseDir();
  if (!fs.existsSync(baseDir)) return;

  const cutoff = Date.now() - getAttachmentRetentionMs();
  let totalDeleted = 0;
  let totalBytes = 0;

  let groupNames: string[];
  try {
    groupNames = fs.readdirSync(baseDir);
  } catch (err) {
    logger.warn({ err, baseDir }, 'Attachment cleanup: cannot read groups dir');
    return;
  }

  for (const groupName of groupNames) {
    const groupDir = path.join(baseDir, groupName);
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let groupDeleted = 0;
    let groupBytes = 0;

    for (const sub of ATTACHMENT_SUBDIRS) {
      const dir = path.join(groupDir, sub);
      if (!fs.existsSync(dir)) continue;

      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          if (stat.mtimeMs >= cutoff) continue;
          fs.rmSync(filePath, { force: true });
          groupDeleted++;
          groupBytes += stat.size;
        } catch (err) {
          logger.warn(
            { err, filePath },
            'Attachment cleanup: failed to delete file',
          );
        }
      }
    }

    if (groupDeleted > 0) {
      logger.info(
        { group: groupName, deleted: groupDeleted, bytes: groupBytes },
        'Attachment cleanup: pruned old files',
      );
      totalDeleted += groupDeleted;
      totalBytes += groupBytes;
    }
  }

  if (totalDeleted > 0) {
    logger.info({ totalDeleted, totalBytes }, 'Attachment cleanup: completed');
  }
}

let attachmentCleanupRunning = false;

export function startAttachmentCleanupLoop(): void {
  if (attachmentCleanupRunning) {
    logger.debug('Attachment cleanup loop already running');
    return;
  }
  attachmentCleanupRunning = true;
  logger.info('Attachment cleanup loop started');

  const tick = async () => {
    try {
      await runAttachmentCleanup();
    } catch (err) {
      logger.error({ err }, 'Attachment cleanup loop error');
    }
    setTimeout(tick, ATTACHMENT_CLEANUP_INTERVAL_MS);
  };

  setTimeout(tick, ATTACHMENT_CLEANUP_INITIAL_DELAY_MS);
}

/** @internal - for tests only. */
export function _resetAttachmentCleanupForTests(): void {
  attachmentCleanupRunning = false;
}

// ---------------------------------------------------------------------------
// Session size warnings (heads-up to main group when a session is heavy)
// ---------------------------------------------------------------------------

const COMPACT_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COMPACT_WARNING_INITIAL_DELAY_MS = 90_000;
const COMPACT_WARNING_SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1000;
const COMPACT_WARNING_DEFAULT_THRESHOLD_BYTES = 500_000;

function getCompactWarningThresholdBytes(): number {
  const raw = process.env.AUTO_COMPACT_THRESHOLD_BYTES;
  const n = raw ? parseInt(raw, 10) : COMPACT_WARNING_DEFAULT_THRESHOLD_BYTES;
  return Number.isFinite(n) && n > 0
    ? n
    : COMPACT_WARNING_DEFAULT_THRESHOLD_BYTES;
}

function getProjectRoot(): string {
  return process.env.NANOCLAW_PROJECT_ROOT ?? process.cwd();
}

function sessionFilePath(folder: string, sessionId: string): string {
  return path.join(
    getProjectRoot(),
    'data',
    'sessions',
    folder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

export interface SessionWarningDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Optional clock injection for tests. */
  now?: () => number;
}

interface HeavySession {
  folder: string;
  bytes: number;
  tokensK: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Scan every group's session jsonl. For each one over the threshold AND
 * not warned in the last 7 days, post a single bundled heads-up to the
 * main group. Stays silent when nothing exceeds the threshold.
 */
export async function runSessionWarning(
  deps: SessionWarningDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
  if (!mainEntry) {
    logger.debug('Session warning: no main group registered, skipping');
    return;
  }
  const [mainJid] = mainEntry;

  const sessions = getAllSessions();
  const threshold = getCompactWarningThresholdBytes();
  const now = (deps.now ?? Date.now)();
  const heavy: HeavySession[] = [];

  for (const [folder, sessionId] of Object.entries(sessions)) {
    const file = sessionFilePath(folder, sessionId);
    if (!fs.existsSync(file)) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size < threshold) continue;

    const lastWarnedRaw = getRouterState(`compact_warning_seen:${folder}`);
    const lastWarned = lastWarnedRaw ? parseInt(lastWarnedRaw, 10) : 0;
    if (now - lastWarned < COMPACT_WARNING_SUPPRESSION_MS) continue;

    heavy.push({
      folder,
      bytes: stat.size,
      tokensK: Math.floor(stat.size / 4 / 1024),
    });
  }

  if (heavy.length === 0) return;

  const lines = heavy.map(
    (h) => `• ${h.folder}: ${formatBytes(h.bytes)} (~${h.tokensK}K tokens)`,
  );
  const msg = `Heads up — these sessions are getting heavy and may slow down or fail with UND_ERR_SOCKET:\n${lines.join('\n')}\n\nTo compact, mention @${ASSISTANT_NAME} /compact in the relevant group, or run ./scripts/reset-group-session.sh <folder> for a hard reset. Suppressing further warnings for these groups for 7 days.`;

  try {
    await deps.sendMessage(mainJid, msg);
    for (const h of heavy) {
      setRouterState(`compact_warning_seen:${h.folder}`, String(now));
    }
    logger.info(
      { mainJid, heavy: heavy.map((h) => h.folder) },
      'Session warning sent',
    );
  } catch (err) {
    logger.error({ err }, 'Session warning failed');
  }
}

let sessionWarningRunning = false;

export function startSessionWarningLoop(deps: SessionWarningDeps): void {
  if (sessionWarningRunning) {
    logger.debug('Session warning loop already running');
    return;
  }
  sessionWarningRunning = true;
  logger.info('Session warning loop started');

  const tick = async () => {
    try {
      await runSessionWarning(deps);
    } catch (err) {
      logger.error({ err }, 'Session warning loop error');
    }
    setTimeout(tick, COMPACT_WARNING_INTERVAL_MS);
  };

  setTimeout(tick, COMPACT_WARNING_INITIAL_DELAY_MS);
}

/** @internal - for tests only. */
export function _resetSessionWarningForTests(): void {
  sessionWarningRunning = false;
}
