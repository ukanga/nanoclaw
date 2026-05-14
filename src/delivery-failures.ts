/**
 * Track replies the host emitted but the outbound channel failed to deliver
 * (e.g. signal-cli TLS errors on attachment uploads). Drained at the top of
 * the agent's next turn so its worldview doesn't silently diverge from
 * reality. Lives in memory only — restart drops pending notices, which is
 * acceptable for a transient signal.
 */
import { escapeXml } from './router.js';

export interface DeliveryFailure {
  timestamp: string;
  cleaned: string;
  reason: string;
}

const pending = new Map<string, DeliveryFailure[]>();

export function recordDeliveryFailure(
  jid: string,
  cleaned: string,
  err: unknown,
): void {
  const reason = err instanceof Error ? err.message : String(err);
  const list = pending.get(jid) ?? [];
  list.push({ timestamp: new Date().toISOString(), cleaned, reason });
  pending.set(jid, list);
}

export function drainDeliveryFailures(jid: string): DeliveryFailure[] {
  const list = pending.get(jid);
  if (!list || list.length === 0) return [];
  pending.delete(jid);
  return list;
}

export function formatDeliveryFailureBlock(
  failures: DeliveryFailure[],
): string {
  if (failures.length === 0) return '';
  const entries = failures
    .map(
      (f) =>
        `<failed-reply at="${escapeXml(f.timestamp)}" reason="${escapeXml(f.reason)}">\n${f.cleaned}\n</failed-reply>`,
    )
    .join('\n');
  return `<delivery-failures note="Replies below were emitted by you earlier but did NOT reach the user. Decide whether to re-send (verbatim, summarized, or as a different file) — do not assume the user has seen them.">\n${entries}\n</delivery-failures>\n`;
}

// Exposed for tests so the module-level Map can be reset between cases.
export function _resetForTests(): void {
  pending.clear();
}
