import * as path from 'node:path';

import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

const AGENT_GROUP_ROOT = '/workspace/group/';
const ATTACH_MARKER_REGEX = /\[\[attach:([^\]\n]+)\]\]/g;

/**
 * Extract `[[attach:<agent-path>]]` markers from agent output.
 *
 * Markers reference the agent-side path (under `/workspace/group/`); we
 * translate to the absolute host path under `groupsBaseDir/groupFolder/`
 * and reject anything that escapes the group root via path traversal.
 *
 * The function is non-throwing: invalid markers are dropped from the text
 * and recorded in `rejected` so the caller can log without losing the
 * surrounding reply.
 */
export function parseAttachmentMarkers(
  text: string,
  groupFolder: string,
  groupsBaseDir: string,
): { text: string; attachments: string[]; rejected: string[] } {
  const attachments: string[] = [];
  const rejected: string[] = [];
  const groupRoot = path.resolve(groupsBaseDir, groupFolder);

  const cleaned = text.replace(ATTACH_MARKER_REGEX, (_, rawPath: string) => {
    const trimmed = rawPath.trim();
    if (!trimmed.startsWith(AGENT_GROUP_ROOT)) {
      rejected.push(trimmed);
      return '';
    }
    const rel = trimmed.slice(AGENT_GROUP_ROOT.length);
    const hostPath = path.resolve(groupRoot, rel);
    if (hostPath !== groupRoot && !hostPath.startsWith(groupRoot + path.sep)) {
      rejected.push(trimmed);
      return '';
    }
    attachments.push(hostPath);
    return '';
  });

  // Tidy whitespace left behind by stripped markers.
  const tidied = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { text: tidied.trim(), attachments, rejected };
}

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
