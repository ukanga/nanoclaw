/**
 * Session rotation — proactive `/compact` when the SDK transcript on disk
 * grows past a byte threshold.
 *
 * Why bytes (not tokens): the Claude Code SDK has its own auto-compact at
 * ~165k tokens, which lands very late and adds painful latency to every
 * pre-compact turn. Watching the transcript's live (post-prior-compact)
 * byte count lets us trigger earlier and keep turns snappy. The cost is
 * one extra `/compact` per long session — invisible to the user.
 *
 * Why container-side (not host): the container owns the SDK conversation
 * and its transcript file. The host has no direct handle on either; going
 * through `messages_in` would require a custom kind and a swallow path on
 * the way back. Pushing `/compact` straight into the open SDK stream is
 * simpler and matches v1's silent-rotation contract.
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_THRESHOLD_BYTES = 500_000;
const DEFAULT_SDK_PROJECTS_DIR = '/home/node/.claude/projects';

/**
 * Where the Claude Code SDK keeps its per-project transcript directories.
 * Resolved on every call so tests can repoint it via `CLAUDE_PROJECTS_DIR`
 * without restarting the process. Defaults to the in-container path.
 */
function sdkProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR || DEFAULT_SDK_PROJECTS_DIR;
}

/**
 * Resolved from `AUTO_COMPACT_THRESHOLD_BYTES` env on every call so a
 * running container can be tuned without a restart. Invalid/zero values
 * fall back to the default — matches v1's `getAutoCompactThresholdBytes`.
 */
export function getAutoCompactThresholdBytes(): number {
  const raw = process.env.AUTO_COMPACT_THRESHOLD_BYTES;
  const n = raw ? parseInt(raw, 10) : DEFAULT_THRESHOLD_BYTES;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_BYTES;
}

/**
 * Resolve the SDK transcript jsonl for a given cwd + SDK session id.
 * Claude Code derives the project key from cwd by stripping the leading
 * `/` then replacing every remaining `/` with `-`. e.g. `/workspace/agent`
 * → `-workspace-agent`.
 */
export function transcriptPath(continuation: string, cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '');
  const projectKey = '-' + normalized.replace(/^\/+/, '').replace(/\//g, '-');
  return path.join(sdkProjectsDir(), projectKey, `${continuation}.jsonl`);
}

/**
 * Live (post-compact) bytes in a transcript — what the SDK actually loads
 * on resume. The SDK only feeds content from the last `compact_boundary`
 * marker onward to the model; pre-boundary turns stay in the jsonl for
 * forensics. Returns the full size when no boundary is present.
 *
 * `totalBytes` is passed in so the caller can pair it with a single
 * `statSync` in shouldRotateSession (avoids re-stat'ing).
 */
export function liveSessionBytes(file: string, totalBytes: number): number {
  const content = fs.readFileSync(file, 'utf-8');
  const idx = content.lastIndexOf('"subtype":"compact_boundary"');
  if (idx === -1) return totalBytes;
  const newlineAfterBoundary = content.indexOf('\n', idx);
  if (newlineAfterBoundary === -1) return 0;
  return Buffer.byteLength(content.slice(newlineAfterBoundary + 1), 'utf-8');
}

/**
 * Threshold predicate: true when the live transcript bytes for `continuation`
 * are at or above the configured limit. Missing file → false (nothing to
 * rotate yet). Any stat/read error → false (fail open — a later turn will
 * try again). Never throws.
 */
export function shouldRotateSession(continuation: string, cwd: string): boolean {
  const file = transcriptPath(continuation, cwd);
  if (!fs.existsSync(file)) return false;
  try {
    const totalBytes = fs.statSync(file).size;
    const live = liveSessionBytes(file, totalBytes);
    return live >= getAutoCompactThresholdBytes();
  } catch {
    return false;
  }
}
