/**
 * Attachment TTL sweep — periodic cleanup of session inbox/outbox dirs.
 *
 * Walks every `<sessionsBaseDir>/<agentGroupId>/<sessionId>/{inbox,outbox}/
 * <messageId>/*` and removes files whose mtime is older than
 * ATTACHMENT_RETENTION_DAYS (default 30). Empty `<messageId>` subdirs are
 * removed in the same pass; the parent `inbox/`/`outbox/` dirs are kept
 * since `initSessionFolder` owns them.
 *
 * The host's `clearOutbox` removes per-message outbox dirs after successful
 * delivery; this sweep catches what slipped through (failed deliveries,
 * abandoned sessions) and is the *only* cleanup path for inbox files.
 *
 * Cadence: 60s startup delay (lets the host finish booting first), then a
 * walk every hour.
 */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import { sessionsBaseDir } from './session-manager.js';

const ATTACHMENT_SUBDIRS = ['inbox', 'outbox'] as const;
export const DEFAULT_RETENTION_DAYS = 30;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const INITIAL_DELAY_MS = 60_000;

export function attachmentRetentionMs(): number {
  const raw = process.env.ATTACHMENT_RETENTION_DAYS;
  const days = raw ? parseInt(raw, 10) : DEFAULT_RETENTION_DAYS;
  const safe = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  return safe * 86_400_000;
}

export function isFileExpired(stat: fs.Stats, cutoffMs: number): boolean {
  return stat.isFile() && stat.mtimeMs < cutoffMs;
}

interface SweepResult {
  deleted: number;
  bytes: number;
}

/**
 * Sweep one session's attachment dirs. Pure-ish: only filesystem side
 * effects, no DB. Returns counters for the caller to aggregate / log.
 */
export function sweepSessionAttachments(sessionDirPath: string, cutoffMs: number): SweepResult {
  let deleted = 0;
  let bytes = 0;

  for (const sub of ATTACHMENT_SUBDIRS) {
    const subDir = path.join(sessionDirPath, sub);
    let messageIds: string[];
    try {
      messageIds = fs.readdirSync(subDir);
    } catch {
      continue;
    }

    for (const msgId of messageIds) {
      const msgDir = path.join(subDir, msgId);
      let entries: string[];
      try {
        entries = fs.readdirSync(msgDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const filePath = path.join(msgDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (!isFileExpired(stat, cutoffMs)) continue;
          fs.rmSync(filePath, { force: true });
          deleted++;
          bytes += stat.size;
        } catch (err) {
          log.warn('Attachment sweep: failed to delete file', { filePath, err });
        }
      }

      // If we emptied the messageId dir, remove it. Skip noisily-failed
      // rmdir — a concurrent writer may have raced us, and we'll catch
      // the dir on the next pass.
      try {
        if (fs.readdirSync(msgDir).length === 0) {
          fs.rmdirSync(msgDir);
        }
      } catch {
        // ignore
      }
    }
  }

  return { deleted, bytes };
}

/**
 * Walk every session under sessionsBaseDir and sweep its inbox/outbox.
 * Uses a filesystem walk rather than the active-sessions table so
 * abandoned session dirs (rows deleted but files left behind) still get
 * cleaned.
 */
export async function runAttachmentSweep(): Promise<void> {
  const root = sessionsBaseDir();
  if (!fs.existsSync(root)) return;

  const cutoff = Date.now() - attachmentRetentionMs();
  let totalDeleted = 0;
  let totalBytes = 0;

  let agentGroupDirs: string[];
  try {
    agentGroupDirs = fs.readdirSync(root);
  } catch (err) {
    log.warn('Attachment sweep: cannot read sessions root', { root, err });
    return;
  }

  for (const agentGroupId of agentGroupDirs) {
    const agentGroupDir = path.join(root, agentGroupId);
    let sessionDirs: string[];
    try {
      if (!fs.statSync(agentGroupDir).isDirectory()) continue;
      sessionDirs = fs.readdirSync(agentGroupDir);
    } catch {
      continue;
    }

    for (const sessionId of sessionDirs) {
      const sessionDirPath = path.join(agentGroupDir, sessionId);
      try {
        if (!fs.statSync(sessionDirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const { deleted, bytes } = sweepSessionAttachments(sessionDirPath, cutoff);
      if (deleted > 0) {
        log.info('Attachment sweep: pruned old files', {
          agentGroupId,
          sessionId,
          deleted,
          bytes,
        });
        totalDeleted += deleted;
        totalBytes += bytes;
      }
    }
  }

  if (totalDeleted > 0) {
    log.info('Attachment sweep: completed', { totalDeleted, totalBytes });
  }
}

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function startAttachmentSweep(): void {
  if (running) return;
  running = true;
  log.info('Attachment sweep loop started');

  const tick = async () => {
    if (!running) return;
    try {
      await runAttachmentSweep();
    } catch (err) {
      log.error('Attachment sweep loop error', { err });
    }
    if (running) {
      timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    }
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
}

export function stopAttachmentSweep(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** @internal — test reset hook. */
export function _resetForTests(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
