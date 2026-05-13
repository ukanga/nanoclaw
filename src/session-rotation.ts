import fs from 'fs';

import { ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import {
  getAutoCompactThresholdBytes,
  liveSessionBytes,
  sessionFilePath,
} from './session-files.js';
import { RegisteredGroup } from './types.js';

const CONTINUATION_PROMPT = `<internal>
Session size has reached the rotation threshold and will be compacted next.
Before compaction, update /workspace/group/CLAUDE.md:

Find the section titled "## Continuation notes" (create it at the end of the
file if missing). Replace its entire contents with two short subsections:

  ### What was just accomplished
  - Bullet list of the main outcomes of this session (3-6 bullets max)

  ### What was about to happen next
  - Pending follow-ups, promised actions, half-finished work, open threads
    with the user that did not resolve. If nothing is pending, write
    "(nothing pending)".

Keep the whole section under 200 words. Use the Edit tool. Do not respond
with anything else — the next step will compact the session.
</internal>`;

export interface MaybeAutoRotateSessionOpts {
  group: RegisteredGroup;
  chatJid: string;
  sessionId: string | undefined;
  setTyping: (on: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => Promise<'success' | 'error'>;
}

/**
 * Post-reply session rotation. If the group's session has crossed the byte
 * threshold, ask the agent to write a "Continuation notes" section to the
 * per-group CLAUDE.md, then issue `/compact` to shrink the session. Runs
 * inline within the per-group message loop so subsequent batches land on
 * the freshly compacted session.
 *
 * Silent from the user's POV (typing indicator only). Errors are logged
 * but never surface to the user — the next post-reply check retries.
 */
export async function maybeAutoRotateSession(
  opts: MaybeAutoRotateSessionOpts,
): Promise<void> {
  const { group, sessionId, setTyping, runAgent } = opts;
  if (!sessionId) return;

  const file = sessionFilePath(group.folder, sessionId);
  if (!fs.existsSync(file)) return;

  let liveBytes: number;
  try {
    const totalBytes = fs.statSync(file).size;
    liveBytes = liveSessionBytes(file, totalBytes);
  } catch (err) {
    logger.warn(
      { group: group.name, folder: group.folder, err },
      'Auto-rotate: stat failed, skipping',
    );
    return;
  }

  const threshold = getAutoCompactThresholdBytes();
  if (liveBytes < threshold) return;

  logger.info(
    { group: group.name, folder: group.folder, liveBytes, threshold },
    'Auto-rotating session',
  );

  // No-op callback: rotation is an admin operation; any stray agent output
  // must not reach the user. The reply for the triggering turn has already
  // been delivered before this runs.
  const swallow = async () => {};

  try {
    await setTyping(true);

    const noteResult = await runAgent(CONTINUATION_PROMPT, swallow);
    if (noteResult === 'error') {
      logger.warn(
        { group: group.name, folder: group.folder },
        'Auto-rotate: continuation-notes step failed, skipping /compact',
      );
      return;
    }

    const compactResult = await runAgent('/compact', swallow);
    if (compactResult === 'error') {
      logger.warn(
        { group: group.name, folder: group.folder },
        'Auto-rotate: /compact step failed',
      );
      return;
    }

    logger.info(
      { group: group.name, folder: group.folder },
      'Auto-rotate complete',
    );
  } catch (err) {
    logger.error(
      { group: group.name, folder: group.folder, err },
      'Auto-rotate: unexpected error',
    );
  } finally {
    try {
      await setTyping(false);
    } catch (err) {
      logger.warn({ err }, 'Auto-rotate: setTyping(false) failed');
    }
  }
}
