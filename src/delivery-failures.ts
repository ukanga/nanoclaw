/**
 * On permanent outbound delivery failure (retries exhausted), surface what
 * was emitted back to the agent so its worldview doesn't silently diverge
 * from reality. The row is `trigger=0` so it doesn't wake the agent on its
 * own — it rides along the next user-triggered turn, prepended to the
 * formatted prompt as a <delivery-failures> block.
 *
 * Inbound.db is the right home because:
 *   - it's per-session — failures land beside the conversation they belong to
 *   - the container's existing getPendingMessages picks them up automatically
 *   - they persist across host restarts (v1's in-memory Map lost these)
 */
import { randomUUID } from 'node:crypto';

import { writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

export interface FailedOutboundMessage {
  id: string;
  content: string;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function recordDeliveryFailureForAgent(session: Session, msg: FailedOutboundMessage, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  let payload: unknown;
  try {
    payload = JSON.parse(msg.content);
  } catch {
    payload = msg.content;
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `delivery-failure-${randomUUID()}`,
    kind: 'delivery-failure',
    timestamp: new Date().toISOString(),
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
    trigger: 0,
    content: JSON.stringify({
      originalMessageOutId: msg.id,
      reason,
      payload,
    }),
  });
}
