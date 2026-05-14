import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import type {
  AttachmentMeta,
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const AGENT_INBOX_PREFIX = '/workspace/group/inbox';
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
};

function getSignalAttachmentsCacheDir(): string {
  return (
    process.env.SIGNAL_ATTACHMENTS_DIR ??
    path.join(os.homedir(), '.local', 'share', 'signal-cli', 'attachments')
  );
}

function sanitizeAttachmentName(
  filename: string | undefined,
  fallbackId: string,
  contentType: string | undefined,
): string {
  const base = path.basename((filename ?? '').trim());
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_');
  if (!cleaned || /^[._]+$/.test(cleaned)) {
    // signal-cli stores some attachments under an id that already includes
    // the original extension (e.g. "wx58uQ1uPhnJnxVRpXGu.png"); only append
    // a contentType-derived extension when the id has none.
    const idHasExt = /\.[A-Za-z0-9]+$/.test(fallbackId);
    const ext =
      !idHasExt && contentType ? (CONTENT_TYPE_EXT[contentType] ?? '') : '';
    return `attachment-${fallbackId}${ext}`;
  }
  return cleaned;
}

function signalCachePlaceholderExists(cacheDir: string, id: string): boolean {
  const direct = path.join(cacheDir, id);
  if (fs.existsSync(direct)) return true;
  try {
    return fs
      .readdirSync(cacheDir)
      .some((f) => f === id || f.startsWith(`${id}.`));
  } catch {
    return false;
  }
}

function findCachedAttachment(cacheDir: string, id: string): string | null {
  // Reject 0-byte hits: signal-cli leaves empty placeholders when its blob download from cdnX.signal.org fails.
  const direct = path.join(cacheDir, id);
  if (fs.existsSync(direct) && fs.statSync(direct).size > 0) return direct;
  try {
    const matches = fs
      .readdirSync(cacheDir)
      .filter((f) => f === id || f.startsWith(`${id}.`));
    for (const match of matches) {
      const p = path.join(cacheDir, match);
      if (fs.statSync(p).size > 0) return p;
    }
  } catch {
    /* unreadable cache dir */
  }
  return null;
}

function materializeAttachments(
  attachments: SignalAttachment[],
  groupFolder: string,
  msgTimestamp: number,
): AttachmentMeta[] {
  const cacheDir = getSignalAttachmentsCacheDir();
  const groupsBase = process.env.NANOCLAW_GROUPS_DIR ?? GROUPS_DIR;
  const inboxDir = path.join(groupsBase, groupFolder, 'inbox');
  const result: AttachmentMeta[] = [];

  for (const att of attachments) {
    if (!att.id) continue;

    const size = att.size ?? 0;
    if (size > MAX_ATTACHMENT_BYTES) {
      logger.warn(
        { id: att.id, size, max: MAX_ATTACHMENT_BYTES },
        'Signal: skipping oversize attachment',
      );
      continue;
    }

    const src = findCachedAttachment(cacheDir, att.id);
    if (!src) {
      const placeholder = signalCachePlaceholderExists(cacheDir, att.id);
      logger.warn(
        { id: att.id, cacheDir, placeholder },
        placeholder
          ? 'Signal: attachment cache file is empty (signal-cli download failed), skipping'
          : 'Signal: attachment cache file missing, skipping',
      );
      continue;
    }

    const sanitized = sanitizeAttachmentName(
      att.filename,
      att.id,
      att.contentType,
    );
    const destName = `${msgTimestamp}-${sanitized}`;
    const destPath = path.join(inboxDir, destName);

    try {
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.copyFileSync(src, destPath);
      if (fs.statSync(destPath).size === 0) {
        // Race: source had bytes during findCachedAttachment but was truncated/rotated before the copy.
        try {
          fs.unlinkSync(destPath);
        } catch {
          /* best-effort */
        }
        logger.warn(
          { id: att.id, src, destPath },
          'Signal: copied attachment was 0 bytes, dropping',
        );
        continue;
      }
    } catch (err) {
      logger.warn({ err, src, destPath }, 'Signal: failed to copy attachment');
      continue;
    }

    result.push({
      path: `${AGENT_INBOX_PREFIX}/${destName}`,
      contentType: att.contentType ?? 'application/octet-stream',
      filename: att.filename ?? sanitized,
      size,
    });
  }

  return result;
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentMarker(att: AttachmentMeta): string {
  return `[Attachment: ${att.path}, ${att.contentType}, ${humanFileSize(att.size)}]`;
}

// ---------------------------------------------------------------------------
// Signal CLI daemon management
// ---------------------------------------------------------------------------

interface DaemonHandle {
  stop: () => void;
  exited: Promise<void>;
  isExited: () => boolean;
}

function spawnSignalDaemon(
  cliPath: string,
  account: string,
  host: string,
  port: number,
): DaemonHandle {
  const args: string[] = [];
  if (account) args.push('-a', account);
  args.push('daemon', '--http', `${host}:${port}`, '--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  const child = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;

  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        logger.error({ reason }, 'signal-cli daemon exited');
      }
      resolve();
    });
    child.on('error', (err) => {
      exited = true;
      logger.error({ err }, 'signal-cli spawn error');
      resolve();
    });
  });

  // Log daemon output
  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (line.trim()) logger.debug({ src: 'signal-cli' }, line.trim());
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/\b(ERROR|WARN|FAILED|SEVERE)\b/i.test(line)) {
        logger.warn({ src: 'signal-cli' }, line.trim());
      } else {
        logger.debug({ src: 'signal-cli' }, line.trim());
      }
    }
  });

  return {
    stop: () => {
      if (!child.killed && !exited) child.kill('SIGTERM');
    },
    exited: exitedPromise,
    isExited: () => exited,
  };
}

// ---------------------------------------------------------------------------
// HTTP JSON-RPC client for signal-cli daemon
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 30_000;

// Network-class failure signatures we retry on. signal-cli surfaces the
// underlying JVM/HTTP error in the JSON-RPC error message; these indicate
// the message did not reach Signal's servers, so a retry will not duplicate.
// NOTE: we deliberately do NOT retry on our own AbortController timeout
// (DOMException with name='AbortError'): when our 30s timeout fires,
// signal-cli may have already delivered, and a retry would duplicate.
const RETRYABLE_SEND_PATTERNS: RegExp[] = [
  /UnknownHostException/,
  /SocketTimeoutException/,
  /SocketException/i,
  /bad_record_mac/,
  /UND_ERR_SOCKET/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /Broken pipe/,
  /Connection reset/,
  /PushNetworkException/,
];
const SEND_BACKOFF_MS = [2_000, 5_000];
const ATTACHMENT_SEND_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

function isRetryableSendError(err: unknown): boolean {
  // Client-side timeout: delivery state is unknown, do not retry.
  if (err instanceof Error && err.name === 'AbortError') return false;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  return RETRYABLE_SEND_PATTERNS.some((p) => p.test(msg));
}

async function signalRpc<T = unknown>(
  baseUrl: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const id = Math.random().toString(36).slice(2);
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (res.status === 201) return undefined as T;

    const text = await res.text();
    if (!text) throw new Error(`Signal RPC empty response (${res.status})`);

    const parsed = JSON.parse(text);
    if (parsed.error) {
      const msg = parsed.error.message ?? 'Signal RPC error';
      throw new Error(msg);
    }
    return parsed.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function signalCheck(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/check`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSE client for inbound events
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string;
  data?: string;
}

async function streamSse(
  url: string,
  onEvent: (event: SseEvent) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: abortSignal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Signal SSE failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: SseEvent = {};

  const flush = () => {
    if (current.data || current.event) {
      onEvent({ event: current.event, data: current.data });
      current = {};
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        flush();
      } else if (!line.startsWith(':')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const field = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trimStart();
          if (field === 'event') current.event = val;
          else if (field === 'data')
            current.data = current.data ? `${current.data}\n${val}` : val;
        }
      }

      lineEnd = buffer.indexOf('\n');
    }
  }
  flush();
}

// ---------------------------------------------------------------------------
// Echo cache
// ---------------------------------------------------------------------------

const ECHO_TTL_MS = 10_000;

class EchoCache {
  private entries = new Map<string, number>();

  remember(text: string) {
    const key = text.trim();
    if (!key) return;
    this.entries.set(key, Date.now());
    this.cleanup();
  }

  isEcho(text: string): boolean {
    const key = text.trim();
    if (!key) return false;
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (Date.now() - ts > ECHO_TTL_MS) {
      this.entries.delete(key);
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts > ECHO_TTL_MS) this.entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Signal envelope types (from signal-cli SSE)
// ---------------------------------------------------------------------------

interface SignalQuote {
  id?: number;
  authorNumber?: string;
  authorUuid?: string;
  text?: string;
}

interface SignalAttachment {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: { groupId?: string; groupName?: string; type?: string };
  quote?: SignalQuote;
  attachments?: SignalAttachment[];
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  dataMessage?: SignalDataMessage;
  syncMessage?: {
    sentMessage?: SignalDataMessage & {
      destination?: string;
      destinationNumber?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// SignalChannel
// ---------------------------------------------------------------------------

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const JID_PREFIX = 'signal:';

export class SignalChannel implements Channel {
  name = 'signal';

  private daemon: DaemonHandle | null = null;
  private sseAbort: AbortController | null = null;
  private connected = false;
  private echoCache = new EchoCache();
  private recentSends = new Map<string, number>();
  private baseUrl: string;

  constructor(
    private cliPath: string,
    private account: string,
    private httpHost: string,
    private httpPort: number,
    private opts: SignalChannelOpts,
    private manageDaemon: boolean,
  ) {
    this.baseUrl = `http://${httpHost}:${httpPort}`;
  }

  async connect(): Promise<void> {
    // Start daemon if we're managing it
    if (this.manageDaemon) {
      this.daemon = spawnSignalDaemon(
        this.cliPath,
        this.account,
        this.httpHost,
        this.httpPort,
      );

      // Wait for the daemon to be ready
      const ready = await this.waitForDaemon();
      if (!ready) {
        this.daemon.stop();
        throw new Error(
          'Signal daemon failed to start. Is signal-cli installed and your account linked?',
        );
      }
    } else {
      // Verify externally managed daemon is reachable
      const ok = await signalCheck(this.baseUrl);
      if (!ok) {
        throw new Error(
          `Signal daemon not reachable at ${this.baseUrl}. Start it manually or set SIGNAL_MANAGE_DAEMON=true`,
        );
      }
    }

    // Ensure profile name is set (signal-cli warns and may reject sends without one)
    try {
      await signalRpc(this.baseUrl, 'updateProfile', {
        name: ASSISTANT_NAME,
        account: this.account,
      });
    } catch {
      logger.debug('Signal: could not set profile name');
    }

    // Enable typing indicators so recipients see "composing" status
    try {
      await signalRpc(this.baseUrl, 'updateConfiguration', {
        typingIndicators: true,
        account: this.account,
      });
    } catch {
      logger.debug('Signal: could not enable typing indicators');
    }

    // Start SSE event loop
    this.connected = true;
    this.sseAbort = new AbortController();
    this.runSseLoop(this.sseAbort.signal);

    logger.info(
      { account: this.account, url: this.baseUrl },
      'Signal channel connected',
    );
    console.log(`\n  Signal: connected (${this.account})`);
    console.log(
      `  Register chats with JID format: signal:<phone-or-uuid> or signal:group:<id>\n`,
    );
  }

  async sendMessage(
    jid: string,
    text: string,
    attachments?: string[],
  ): Promise<void> {
    if (!this.connected) {
      logger.warn('Signal: not connected, cannot send');
      return;
    }

    const target = jid.replace(/^signal:/, '');
    if (!target) {
      logger.warn({ jid }, 'Signal: empty target');
      return;
    }

    // Validate attachment paths up-front so we fail before any network call.
    const attachmentPaths: string[] = [];
    if (attachments && attachments.length > 0) {
      for (const p of attachments) {
        if (!path.isAbsolute(p)) {
          throw new Error(`Signal: attachment path must be absolute: ${p}`);
        }
        if (!fs.existsSync(p)) {
          throw new Error(`Signal: attachment file not found: ${p}`);
        }
        attachmentPaths.push(p);
      }
    }

    // Prefix with assistant name when sharing an account (Note to Self)
    const outText =
      !ASSISTANT_HAS_OWN_NUMBER && target === this.account
        ? `${ASSISTANT_NAME}: ${text}`
        : text;

    this.echoCache.remember(outText);

    // Deduplicate: skip if the same text and attachments were sent to the same JID recently.
    // This prevents double-sends when both streaming output and IPC send_message
    // fire for the same agent response, or when the styled-send retry triggers
    // after the first send already delivered the message.
    const DEDUP_TTL_MS = 5_000;
    const attachmentDedupeKey = attachmentPaths.join('\0');
    const dedupeKey = `${jid}:${outText.trim()}:${attachmentDedupeKey}`;
    const now = Date.now();
    const lastSent = this.recentSends.get(dedupeKey);
    if (lastSent && now - lastSent < DEDUP_TTL_MS) {
      logger.debug({ jid }, 'Signal: skipping duplicate outbound message');
      return;
    }
    this.recentSends.set(dedupeKey, now);
    // Prune stale entries
    for (const [key, ts] of this.recentSends) {
      if (now - ts > DEDUP_TTL_MS) this.recentSends.delete(key);
    }

    // Split long messages
    const MAX_CHUNK = 4000;
    const chunks =
      outText.length <= MAX_CHUNK ? [outText] : chunkText(outText, MAX_CHUNK);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const { text: plainText, textStyles } = parseSignalStyles(chunk);
      const params: Record<string, unknown> = { message: plainText };
      if (this.account) params.account = this.account;
      // signal-cli JSON-RPC uses "textStyle" (singular) with string format "start:length:STYLE"
      if (textStyles.length > 0) {
        params.textStyle = textStyles.map(
          (s) => `${s.start}:${s.length}:${s.style}`,
        );
      }

      // Attach files only to the first chunk to avoid duplicate uploads.
      if (i === 0 && attachmentPaths.length > 0) {
        params.attachments = attachmentPaths;
      }

      if (target.startsWith('group:')) {
        params.groupId = target.slice('group:'.length);
      } else {
        params.recipient = [target];
      }

      // Retry only the specific network-class failures we've seen drop
      // messages silently (DNS, TLS, undici/JVM socket aborts). signal-cli
      // returns an error on these *before* a Signal-server ack, so retrying
      // is safe — the message has not been delivered. We deliberately do NOT
      // retry generic errors (invalid group id, missing attachment, etc).
      const sendBackoffMs =
        attachmentPaths.length > 0
          ? ATTACHMENT_SEND_BACKOFF_MS
          : SEND_BACKOFF_MS;
      const maxSendRetries = sendBackoffMs.length;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= maxSendRetries; attempt++) {
        try {
          try {
            await signalRpc(this.baseUrl, 'send', params);
          } catch (styledErr) {
            const errMsg = styledErr instanceof Error ? styledErr.message : '';
            const isTextStyleRejection =
              textStyles.length > 0 &&
              (errMsg.includes('textStyle') ||
                errMsg.includes('Unknown parameter'));
            if (isTextStyleRejection) {
              logger.debug(
                'Signal: textStyle rejected, retrying without styles',
              );
              delete params.textStyle;
              params.message = plainText;
              await signalRpc(this.baseUrl, 'send', params);
            } else {
              throw styledErr;
            }
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isRetryableSendError(err) || attempt >= maxSendRetries) {
            break;
          }
          const delay = sendBackoffMs[attempt] ?? 5_000;
          logger.warn(
            {
              jid,
              chunkIndex: i,
              attempt: attempt + 1,
              maxRetries: maxSendRetries,
              delayMs: delay,
              err: err instanceof Error ? err.message : String(err),
            },
            'Signal: transient send error, retrying',
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      if (lastErr) {
        // Surface the failure to the caller so it can mark the message as
        // undelivered. Logging "Signal message sent" below would be a lie
        // and leads the agent's session to believe the user received text
        // they never saw.
        logger.error(
          { jid, chunkIndex: i, err: lastErr },
          'Signal: send failed',
        );
        throw lastErr;
      }
    }

    logger.info(
      { jid, length: text.length, attachmentCount: attachmentPaths.length },
      'Signal message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sseAbort?.abort();
    this.sseAbort = null;
    if (this.daemon && this.manageDaemon) {
      this.daemon.stop();
      await this.daemon.exited;
    }
    this.daemon = null;
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    const target = jid.replace(/^signal:/, '');
    if (!target || target.startsWith('group:')) return; // typing only for DMs

    try {
      const params: Record<string, unknown> = { recipient: [target] };
      if (this.account) params.account = this.account;
      if (!isTyping) params.stop = true;
      await signalRpc(this.baseUrl, 'sendTyping', params);
    } catch (err) {
      logger.debug({ jid, err }, 'Signal: typing indicator failed');
    }
  }

  // ---- private ----

  private async waitForDaemon(): Promise<boolean> {
    const maxWait = 30_000;
    const pollInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (this.daemon?.isExited()) return false;
      const ok = await signalCheck(this.baseUrl);
      if (ok) return true;
      await sleep(pollInterval);
    }
    return false;
  }

  private runSseLoop(abortSignal: AbortSignal) {
    const loop = async () => {
      let reconnectAttempts = 0;

      while (!abortSignal.aborted) {
        try {
          const url = this.account
            ? `${this.baseUrl}/api/v1/events?account=${encodeURIComponent(this.account)}`
            : `${this.baseUrl}/api/v1/events`;

          await streamSse(
            url,
            (event) => {
              reconnectAttempts = 0;
              this.handleSseEvent(event).catch((err) => {
                logger.error({ err }, 'Signal: error handling SSE event');
              });
            },
            abortSignal,
          );

          if (abortSignal.aborted) return;
          reconnectAttempts++;
          const delay = computeBackoff(reconnectAttempts);
          logger.debug({ delay }, 'Signal SSE stream ended, reconnecting...');
          await sleep(delay);
        } catch (err) {
          if (abortSignal.aborted) return;
          reconnectAttempts++;
          const delay = computeBackoff(reconnectAttempts);
          logger.warn({ err, delay }, 'Signal SSE error, reconnecting...');
          await sleep(delay);
        }
      }
    };

    loop().catch((err) => {
      if (!abortSignal.aborted) {
        logger.error({ err }, 'Signal SSE loop fatal error');
      }
    });
  }

  private async handleSseEvent(event: SseEvent): Promise<void> {
    if (!event.data) return;

    let envelope: SignalEnvelope;
    try {
      const parsed = JSON.parse(event.data);
      envelope = parsed.envelope ?? parsed;
    } catch {
      logger.debug({ data: event.data }, 'Signal: unparseable SSE event');
      return;
    }

    // Handle sync messages (messages we sent from another device)
    const syncSent = envelope.syncMessage?.sentMessage;
    if (syncSent) {
      const dest = (
        syncSent.destinationNumber ??
        syncSent.destination ??
        ''
      ).trim();
      // "Note to Self" — destination is our own account number
      if (dest === this.account) {
        const text = (syncSent.message ?? '').trim();
        if (!text) return;
        if (this.echoCache.isEcho(text)) return;
        const chatJid = `${JID_PREFIX}${this.account}`;
        const timestamp = syncSent.timestamp
          ? new Date(syncSent.timestamp).toISOString()
          : new Date().toISOString();
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          'Note to Self',
          'signal',
          false,
        );
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug({ chatJid }, 'Message from unregistered Signal chat');
          return;
        }

        let syncContent = text;
        if (syncSent.quote) {
          const q = syncSent.quote;
          const quoteAuthor = q.authorNumber ?? 'someone';
          const quoteText = q.text ?? '';
          if (quoteText) {
            syncContent = `> ${quoteAuthor}: ${quoteText}\n\n${syncContent}`;
          }
        }

        this.opts.onMessage(chatJid, {
          id: String(syncSent.timestamp ?? Date.now()),
          chat_jid: chatJid,
          sender: this.account,
          sender_name: 'Me',
          content: syncContent,
          timestamp,
          is_from_me: true,
        });
        return;
      }
      // Other sync messages are our outbound — skip
      return;
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    const text = (dataMessage.message ?? '').trim();
    const hasAttachments = Boolean(dataMessage.attachments?.length);
    if (!text && !hasAttachments) return;

    // Determine sender
    const sender = (envelope.sourceNumber ?? envelope.source ?? '').trim();
    if (!sender) return;

    // Skip echoed outbound
    if (text && this.echoCache.isEcho(text)) {
      logger.debug('Signal: skipping echo');
      return;
    }

    const senderName = (envelope.sourceName ?? sender).trim();
    const groupInfo = dataMessage.groupInfo;
    const isGroup = Boolean(groupInfo?.groupId);
    const groupId = groupInfo?.groupId;

    const chatJid = isGroup
      ? `${JID_PREFIX}group:${groupId}`
      : `${JID_PREFIX}${sender}`;

    const timestamp = dataMessage.timestamp
      ? new Date(dataMessage.timestamp).toISOString()
      : new Date().toISOString();

    const chatName =
      groupInfo?.groupName ??
      (isGroup ? `Group ${groupId?.slice(0, 8)}` : senderName);

    // Report metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    // Only deliver for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Signal chat',
      );
      return;
    }

    // Materialize attachments into the group's inbox so the agent can read them
    let materializedAttachments: AttachmentMeta[] = [];
    if (dataMessage.attachments && dataMessage.attachments.length > 0) {
      materializedAttachments = materializeAttachments(
        dataMessage.attachments,
        group.folder,
        dataMessage.timestamp ?? Date.now(),
      );
    }

    let content = text;

    // Prepend quote context so the agent sees what's being replied to
    if (dataMessage.quote) {
      const q = dataMessage.quote;
      const quoteAuthor = q.authorNumber ?? 'someone';
      const quoteText = q.text ?? '';
      if (quoteText) {
        content = `> ${quoteAuthor}: ${quoteText}\n\n${content}`;
      }
    }

    // Append per-attachment markers so the agent sees the file paths
    if (materializedAttachments.length > 0) {
      const markers = materializedAttachments
        .map(formatAttachmentMarker)
        .join('\n');
      content = content ? `${content}\n${markers}` : markers;
    }

    // Trigger detection for groups
    if (isGroup && !TRIGGER_PATTERN.test(content)) {
      const nameRegex = new RegExp(`\\b${escapeRegex(ASSISTANT_NAME)}\\b`, 'i');
      if (nameRegex.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Drop messages that ended up entirely empty (e.g., oversize-only attachments
    // that all got filtered out, leaving no text and nothing to attach).
    if (!content && materializedAttachments.length === 0) return;

    this.opts.onMessage(chatJid, {
      id: String(dataMessage.timestamp ?? Date.now()),
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      attachments:
        materializedAttachments.length > 0
          ? materializedAttachments
          : undefined,
    });

    logger.info(
      {
        chatJid,
        sender: senderName,
        attachmentCount: materializedAttachments.length,
      },
      'Signal message stored',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Signal text styles — convert Markdown to Signal's offset-based formatting
// ---------------------------------------------------------------------------

interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  start: number;
  length: number;
}

interface StyledText {
  text: string;
  textStyles: SignalTextStyle[];
}

/**
 * Parse Markdown-style formatting into Signal's native text styles.
 * Returns plain text (markup stripped) and an array of style ranges.
 * Offsets are in UTF-16 code units (JavaScript string indices).
 */
function parseSignalStyles(input: string): StyledText {
  const styles: SignalTextStyle[] = [];

  // Pre-process: convert Markdown headings to bold (Signal has no heading support)
  // and strip HTML tags that agents sometimes include
  let preprocessed = input
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/<[^>]+>/g, '');

  // Process code blocks first (``` ... ```) to prevent inner markup parsing
  // Then inline patterns: **bold**, *bold*, _italic_, ~~strike~~, `mono`
  const patterns: Array<{
    regex: RegExp;
    style: SignalTextStyle['style'];
  }> = [
    { regex: /```([\s\S]*?)```/g, style: 'MONOSPACE' },
    { regex: /`([^`]+)`/g, style: 'MONOSPACE' },
    { regex: /\*\*(.+?)\*\*/g, style: 'BOLD' },
    { regex: /\*(.+?)\*/g, style: 'BOLD' },
    { regex: /_(.+?)_/g, style: 'ITALIC' },
    { regex: /~~(.+?)~~/g, style: 'STRIKETHROUGH' },
  ];

  let text = preprocessed;

  for (const { regex, style } of patterns) {
    const nextText: string[] = [];
    let lastIndex = 0;
    let offset = 0;

    for (const match of text.matchAll(regex)) {
      const fullMatch = match[0];
      const innerText = match[1];
      const matchStart = match.index!;

      // Copy text before this match
      nextText.push(text.slice(lastIndex, matchStart));
      const plainStart = matchStart - offset;

      // Add the inner text (without markup)
      nextText.push(innerText);
      styles.push({ style, start: plainStart, length: innerText.length });

      const stripped = fullMatch.length - innerText.length;
      offset += stripped;
      lastIndex = matchStart + fullMatch.length;
    }

    nextText.push(text.slice(lastIndex));
    text = nextText.join('');
  }

  return { text, textStyles: styles };
}

function computeBackoff(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
  const jitter = base * 0.2 * (Math.random() - 0.5);
  return Math.max(500, base + jitter);
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 7583;

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SIGNAL_CLI_PATH',
    'SIGNAL_ACCOUNT',
    'SIGNAL_HTTP_HOST',
    'SIGNAL_HTTP_PORT',
    'SIGNAL_MANAGE_DAEMON',
    'SIGNAL_DATA_DIR',
  ]);

  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  if (!account) {
    logger.debug('Signal: SIGNAL_ACCOUNT not set, skipping channel');
    return null;
  }

  const cliPath =
    process.env.SIGNAL_CLI_PATH || envVars.SIGNAL_CLI_PATH || 'signal-cli';
  const httpHost =
    process.env.SIGNAL_HTTP_HOST ||
    envVars.SIGNAL_HTTP_HOST ||
    DEFAULT_HTTP_HOST;
  const httpPort = parseInt(
    process.env.SIGNAL_HTTP_PORT ||
      envVars.SIGNAL_HTTP_PORT ||
      String(DEFAULT_HTTP_PORT),
    10,
  );
  const manageDaemon =
    (process.env.SIGNAL_MANAGE_DAEMON ||
      envVars.SIGNAL_MANAGE_DAEMON ||
      'true') === 'true';

  // If managing daemon, verify signal-cli exists
  if (manageDaemon && cliPath === 'signal-cli') {
    try {
      execFileSync('which', ['signal-cli'], { stdio: 'ignore' });
    } catch {
      logger.debug('Signal: signal-cli binary not found, skipping channel');
      return null;
    }
  }

  return new SignalChannel(
    cliPath,
    account,
    httpHost,
    httpPort,
    opts,
    manageDaemon,
  );
});
