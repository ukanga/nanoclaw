import fs from 'fs';
import path from 'path';

const AUTO_COMPACT_DEFAULT_THRESHOLD_BYTES = 500_000;

function getProjectRoot(): string {
  return process.env.NANOCLAW_PROJECT_ROOT ?? process.cwd();
}

export function sessionFilePath(folder: string, sessionId: string): string {
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

export function getAutoCompactThresholdBytes(): number {
  const raw = process.env.AUTO_COMPACT_THRESHOLD_BYTES;
  const n = raw ? parseInt(raw, 10) : AUTO_COMPACT_DEFAULT_THRESHOLD_BYTES;
  return Number.isFinite(n) && n > 0 ? n : AUTO_COMPACT_DEFAULT_THRESHOLD_BYTES;
}

/**
 * Live (post-compact) bytes — what the SDK actually loads on resume.
 * The SDK only feeds content from the last `compact_boundary` marker
 * onward to the model; pre-boundary turns stay in the jsonl for
 * forensics. Returns the full file size when no boundary is present.
 */
export function liveSessionBytes(file: string, totalBytes: number): number {
  const content = fs.readFileSync(file, 'utf-8');
  const idx = content.lastIndexOf('"subtype":"compact_boundary"');
  if (idx === -1) return totalBytes;
  const newlineAfterBoundary = content.indexOf('\n', idx);
  if (newlineAfterBoundary === -1) return 0;
  return Buffer.byteLength(content.slice(newlineAfterBoundary + 1), 'utf-8');
}
