/**
 * Signal channel adapter for NanoClaw v2.
 *
 * Uses signal-cli's TCP JSON-RPC daemon for bidirectional messaging.
 * Requires signal-cli (https://github.com/AsamK/signal-cli) installed
 * and a linked account.
 *
 * Ported from v1 — see v1 source for commit history.
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Inbound attachment helpers
// ---------------------------------------------------------------------------

/** Per-attachment ceiling. Larger than typical Signal media (≤ 16 MB) but
 * a defensive cap against signal-cli's local cache returning unexpectedly
 * huge files. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** ContentType → file extension. Used by sanitizeAttachmentName when the
 * filename Signal supplied is missing or unsafe-and-replaced. */
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

/** Locate a cached attachment by id. signal-cli stores files in two shapes:
 *   1. exactly `<id>` (early versions / non-mediatype attachments)
 *   2. `<id>.<ext>` (recent versions that infer extension from MIME)
 * 0-byte hits are rejected — signal-cli leaves empty placeholders when its
 * blob download from `cdnX.signal.org` fails, and we don't want to forward
 * those to the agent. Returns the path of a non-empty file or null. */
function findCachedAttachment(cacheDir: string, id: string): string | null {
  const direct = join(cacheDir, id);
  if (existsSync(direct) && statSync(direct).size > 0) return direct;
  try {
    const matches = readdirSync(cacheDir).filter((f) => f === id || f.startsWith(`${id}.`));
    for (const m of matches) {
      const p = join(cacheDir, m);
      if (statSync(p).size > 0) return p;
    }
  } catch {
    /* unreadable cache dir — treated as missing */
  }
  return null;
}

/** Does signal-cli have *any* file for this id (including a 0-byte
 * placeholder from a failed CDN fetch)? Lets the caller distinguish
 * "missing entirely" from "download failed, placeholder left behind." */
function signalCachePlaceholderExists(cacheDir: string, id: string): boolean {
  if (existsSync(join(cacheDir, id))) return true;
  try {
    return readdirSync(cacheDir).some((f) => f === id || f.startsWith(`${id}.`));
  } catch {
    return false;
  }
}

/** Produce a safe filename for the session inbox. Rejects path traversals
 * and OS-special chars; falls back to `attachment-<id>[.ext]` when the
 * Signal-supplied name is empty or fully sanitises away. The `idHasExt`
 * branch avoids double-extensioning files like `wx58.png` whose signal-cli
 * id already carries the right extension. */
function sanitizeAttachmentName(
  filename: string | undefined,
  fallbackId: string,
  contentType: string | undefined,
): string {
  const base = (filename ?? '').trim();
  // Strip directory components and replace unsafe chars with underscores.
  // path.basename here is defensive in case Signal ever leaks a relative
  // path; the subsequent regex still scrubs forbidden characters.
  const lastSegment = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
  const cleaned = lastSegment.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_');
  if (!cleaned || /^[._]+$/.test(cleaned)) {
    const idHasExt = /\.[A-Za-z0-9]+$/.test(fallbackId);
    const ext = !idHasExt && contentType ? (CONTENT_TYPE_EXT[contentType] ?? '') : '';
    return `attachment-${fallbackId}${ext}`;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Signal CLI daemon management
// ---------------------------------------------------------------------------

interface DaemonHandle {
  stop: () => void;
  exited: Promise<void>;
  isExited: () => boolean;
}

function spawnSignalDaemon(cliPath: string, account: string, host: string, port: number): DaemonHandle {
  const args: string[] = [];
  if (account) args.push('-a', account);
  args.push('daemon', '--tcp', `${host}:${port}`, '--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  const child = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;

  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        log.error('signal-cli daemon exited', { reason });
      }
      resolve();
    });
    child.on('error', (err) => {
      exited = true;
      log.error('signal-cli spawn error', { err });
      resolve();
    });
  });

  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (line.trim()) log.debug('signal-cli stdout', { line: line.trim() });
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/\b(ERROR|WARN|FAILED|SEVERE)\b/i.test(line)) {
        log.warn('signal-cli stderr', { line: line.trim() });
      } else {
        log.debug('signal-cli stderr', { line: line.trim() });
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
// TCP JSON-RPC client for signal-cli daemon (--tcp mode)
//
// signal-cli 0.14.x --tcp exposes a newline-delimited JSON-RPC socket.
// Requests are sent as JSON + newline; responses and push notifications
// (inbound messages) arrive the same way.
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Send retry policy
// ---------------------------------------------------------------------------

// Network-class failure signatures we retry on. signal-cli surfaces the
// underlying JVM/HTTP error in the JSON-RPC error message; these indicate the
// message did not reach Signal's servers, so a retry will not duplicate.
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

// Text sends get a short retry budget; attachment sends get a longer one
// because they survive briefly-broken push connections more often when the
// delay window is wide enough for signal-cli's ReceiveHelper to reconnect.
const SEND_BACKOFF_MS = [2_000, 5_000];
const ATTACHMENT_SEND_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

// Subset of retryable errors that indicate signal-cli's push connection to
// Signal's servers is dead. signal-cli reconnects internally — it logs
// "Connection closed unexpectedly, reconnecting in 100 ms" — but the actual
// reconnect takes several seconds under load. Retrying inside that window
// keeps hitting the same broken socket. Floor the retry delay on these
// errors so the reconnect can land before our next attempt.
const STALE_CONNECTION_PATTERNS: RegExp[] = [/bad_record_mac/, /Broken pipe/, /PushNetworkException/];
const STALE_CONNECTION_MIN_DELAY_MS = 15_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
}

function isRetryableSendError(err: unknown): boolean {
  // Our own RPC timeout: signal-cli may have already delivered the message
  // but the response didn't make it back inside RPC_TIMEOUT_MS. Retrying
  // would duplicate. Surfaced from SignalTcpClient.rpc as
  // `Error('Signal RPC timeout: <method>')`.
  const msg = errMessage(err);
  if (msg.startsWith('Signal RPC timeout:')) return false;
  return RETRYABLE_SEND_PATTERNS.some((p) => p.test(msg));
}

function isStaleConnectionError(err: unknown): boolean {
  const msg = errMessage(err);
  return STALE_CONNECTION_PATTERNS.some((p) => p.test(msg));
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Outbound send dedupe — short-TTL guard against double-sends from upper
// layers (e.g. delivery-loop retry while a previous attempt's response was
// in flight). Keyed on (platformId, text, attachmentPathList) so attaching
// the same caption text to two different files isn't suppressed.
// ---------------------------------------------------------------------------

const SEND_DEDUP_TTL_MS = 5_000;

class SendDedupe {
  private entries = new Map<string, number>();

  private keyFor(platformId: string, text: string, attachments: string[]): string {
    return `${platformId}\x00${text.trim()}\x00${attachments.join('\x00')}`;
  }

  /** Returns true and records the send. Returns false if a duplicate fired within TTL. */
  tryRecord(platformId: string, text: string, attachments: string[]): boolean {
    const key = this.keyFor(platformId, text, attachments);
    const now = Date.now();
    const last = this.entries.get(key);
    if (last !== undefined && now - last < SEND_DEDUP_TTL_MS) return false;
    this.entries.set(key, now);
    this.cleanup(now);
    return true;
  }

  private cleanup(now: number): void {
    for (const [k, ts] of this.entries) {
      if (now - ts > SEND_DEDUP_TTL_MS) this.entries.delete(k);
    }
  }
}

class SignalTcpClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;

  constructor(
    private host: string,
    private port: number,
  ) {}

  connect(handlers?: {
    onNotification?: (method: string, params: unknown) => void;
    onClose?: () => void;
  }): Promise<void> {
    this.onNotification = handlers?.onNotification ?? null;
    this.onClose = handlers?.onClose ?? null;
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.port, this.host, () => {
        this.socket = sock;
        resolve();
      });
      sock.on('error', (err) => {
        if (!this.socket) {
          reject(err);
          return;
        }
        log.warn('Signal TCP socket error', { err });
      });
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('close', () => {
        const wasConnected = this.socket !== null;
        this.socket = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Signal TCP connection closed'));
        }
        this.pending.clear();
        if (wasConnected) this.onClose?.();
      });
    });
  }

  async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.socket) throw new Error('Signal TCP not connected');
    const id = Math.random().toString(36).slice(2);
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Signal RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.write(msg);
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString();
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line) this.handleLine(line);
      newlineIdx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.debug('Signal TCP: unparseable line', { line: line.slice(0, 200) });
      return;
    }

    if (parsed.id && this.pending.has(parsed.id)) {
      const p = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      clearTimeout(p.timer);
      if (parsed.error) {
        p.reject(new Error(parsed.error.message ?? 'Signal RPC error'));
      } else {
        p.resolve(parsed.result);
      }
      return;
    }

    if (parsed.method && this.onNotification) {
      this.onNotification(parsed.method, parsed.params);
    }
  }
}

async function signalTcpCheck(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };
    const sock = createConnection(port, host, () => finish(true));
    sock.on('error', () => finish(false));
    const timer = setTimeout(() => finish(false), 5000);
  });
}

// ---------------------------------------------------------------------------
// Echo cache
// ---------------------------------------------------------------------------

const ECHO_TTL_MS = 10_000;

/**
 * Per-recipient dedup for messages we sent ourselves.
 *
 * signal-cli echoes our own outbound back via syncMessage (and, for Note to
 * Self, via sentMessage-with-self-destination). Without dedup, the agent sees
 * its own replies as new inbound and loops. We remember `(platformId, text)`
 * briefly after every send, and drop the first match within TTL.
 *
 * Keying on text alone is not enough: if we send "hi" to Alice and Bob then
 * sends "hi" from a different chat, Bob's real message gets silently dropped.
 */
class EchoCache {
  private entries = new Map<string, number>();

  private keyFor(platformId: string, text: string): string {
    return `${platformId}\x00${text.trim()}`;
  }

  remember(platformId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.set(this.keyFor(platformId, trimmed), Date.now());
    this.cleanup();
  }

  isEcho(platformId: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const key = this.keyFor(platformId, trimmed);
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (Date.now() - ts > ECHO_TTL_MS) {
      this.entries.delete(key);
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts > ECHO_TTL_MS) this.entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Signal envelope types
// ---------------------------------------------------------------------------

interface SignalQuote {
  id?: number;
  author?: string;
  authorNumber?: string;
  authorUuid?: string;
  authorName?: string;
  text?: string;
}

interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
  name?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  mentions?: SignalMention[];
  groupInfo?: { groupId?: string; groupName?: string; type?: string };
  groupV2?: { id?: string };
  quote?: SignalQuote;
  attachments?: Array<{
    id?: string;
    contentType?: string;
    filename?: string;
    size?: number;
  }>;
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace inline `@<placeholder>` mention markers with display names so the
 * agent sees `@Alice` instead of a raw UUID. Signal's protocol uses a single
 * placeholder character (typically U+FFFC) at each mention's `start` offset.
 */
function resolveMentions(text: string, mentions?: SignalMention[]): string {
  if (!mentions || mentions.length === 0) return text;
  const sorted = [...mentions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let result = '';
  let cursor = 0;
  for (const m of sorted) {
    const start = m.start ?? 0;
    const length = m.length ?? 1;
    const name = m.name || m.number || (m.uuid ? m.uuid.slice(0, 8) : 'someone');
    if (start < cursor) continue;
    result += text.slice(cursor, start) + `@${name}`;
    cursor = start + length;
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Optional voice-note transcription. Tries (in order):
 *   1. local whisper.cpp CLI when `WHISPER_BIN` is set
 *   2. OpenAI Whisper API when `OPENAI_API_KEY` is set
 * Returns null if neither path is configured or transcription fails — caller
 * falls back to a `[Voice Message]` placeholder.
 *
 * Signal voice notes are AAC/ADTS; whisper-cpp wants WAV. ffmpeg is invoked
 * if available to convert; if ffmpeg is missing the local path is skipped.
 */
async function transcribeAudioOptional(filePath: string): Promise<string | null> {
  const whisperBin = process.env.WHISPER_BIN;
  if (whisperBin) {
    try {
      const wavPath = `${filePath}.wav`;
      execSync(`ffmpeg -y -loglevel error -i "${filePath}" -ar 16000 -ac 1 "${wavPath}"`, { stdio: 'ignore' });
      const model = process.env.WHISPER_MODEL || `${homedir()}/.local/share/whisper/models/ggml-base.en.bin`;
      const out = execSync(`"${whisperBin}" -m "${model}" -f "${wavPath}" -nt -otxt -of "${wavPath}"`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      try {
        unlinkSync(wavPath);
        unlinkSync(`${wavPath}.txt`);
      } catch {}
      const text = out.replace(/\[[^\]]*\]/g, '').trim();
      if (text) return text;
    } catch (err) {
      log.debug('Signal: local whisper transcription failed, trying OpenAI', { err });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const buf = readFileSync(filePath);
      const boundary = `----nanoclaw-${Date.now()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.aac"\r\nContent-Type: audio/aac\r\n\r\n`,
        ),
        buf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      if (res.ok) {
        const json = (await res.json()) as { text?: string };
        if (json.text) return json.text.trim();
      }
    } catch (err) {
      log.debug('Signal: OpenAI transcription failed', { err });
    }
  }

  return null;
}

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * Convert Markdown-ish input to Signal's offset-based style ranges.
 *
 * Walks the input recursively: at each level we find the leftmost matching
 * pattern, descend into its captured inner text (so `**bold with \`code\`
 * inside**` stays bold-plus-monospace rather than leaking stripped markers),
 * then continue past the match. Style offsets are recorded against the
 * *output* text length as it's built, so nested styles always point at the
 * right span of the final plain text.
 */
function parseSignalStyles(input: string): StyledText {
  const styles: SignalTextStyle[] = [];

  // Ordering matters: longer/greedier delimiters first so `` ``` `` beats
  // `` ` ``, `**` beats `*`. The italic-`*` pattern refuses to start on
  // whitespace so `*` isn't mistakenly opened on " * " in list-like text.
  const patterns: Array<{ regex: RegExp; style: SignalTextStyle['style'] }> = [
    { regex: /```([\s\S]+?)```/, style: 'MONOSPACE' },
    { regex: /`([^`]+)`/, style: 'MONOSPACE' },
    { regex: /\*\*([^]+?)\*\*/, style: 'BOLD' },
    { regex: /~~([^]+?)~~/, style: 'STRIKETHROUGH' },
    { regex: /\|\|([^]+?)\|\|/, style: 'SPOILER' },
    { regex: /\*([^*\s][^*]*?)\*/, style: 'ITALIC' },
    { regex: /_([^_\s][^_]*?)_/, style: 'ITALIC' },
  ];

  function walk(segment: string, outputBase: number): string {
    let earliest: { start: number; match: RegExpExecArray; style: SignalTextStyle['style'] } | null = null;
    for (const { regex, style } of patterns) {
      const m = regex.exec(segment);
      if (!m) continue;
      if (earliest === null || m.index < earliest.start) {
        earliest = { start: m.index, match: m, style };
      }
    }
    if (!earliest) return segment;

    const before = segment.slice(0, earliest.start);
    const fullMatch = earliest.match[0];
    const inner = earliest.match[1];
    const afterStart = earliest.start + fullMatch.length;
    const after = segment.slice(afterStart);

    const innerOut = walk(inner, outputBase + before.length);
    styles.push({
      style: earliest.style,
      start: outputBase + before.length,
      length: innerOut.length,
    });
    const afterOut = walk(after, outputBase + before.length + innerOut.length);

    return before + innerOut + afterOut;
  }

  const text = walk(input, 0);
  return { text, textStyles: styles };
}

// ---------------------------------------------------------------------------
// SignalAdapter — v2 ChannelAdapter implementation
// ---------------------------------------------------------------------------

/**
 * Platform ID format:
 *   DM:    phone number or UUID (e.g. "+15555550123")
 *   Group: "group:<groupId>" (e.g. "group:abc123")
 *
 * channelType is always "signal". The router combines channelType + platformId
 * to look up or create the messaging_group.
 */
export function createSignalAdapter(config: {
  cliPath: string;
  account: string;
  tcpHost: string;
  tcpPort: number;
  manageDaemon: boolean;
  signalDataDir: string;
}): ChannelAdapter {
  let daemon: DaemonHandle | null = null;
  let tcp: SignalTcpClient | null = null;
  let connected = false;
  const echoCache = new EchoCache();
  const sendDedupe = new SendDedupe();
  let setup: ChannelSetup | null = null;

  // -- inbound handling --

  function handleNotification(method: string, params: unknown): void {
    if (method === 'receive') {
      const envelope = (params as any)?.envelope;
      if (envelope) {
        handleEnvelope(envelope).catch((err) => {
          log.error('Signal: error handling envelope', { err });
        });
      }
    }
  }

  async function handleEnvelope(envelope: SignalEnvelope): Promise<void> {
    if (!setup) return;

    // Sync messages (sent from another device)
    const syncSent = envelope.syncMessage?.sentMessage;
    if (syncSent) {
      const dest = (syncSent.destinationNumber ?? syncSent.destination ?? '').trim();
      // "Note to Self" — destination is our own account
      if (dest === config.account) {
        const text = (syncSent.message ?? '').trim();
        if (!text) return;
        const platformId = config.account;
        if (echoCache.isEcho(platformId, text)) return;
        const timestamp = syncSent.timestamp ? new Date(syncSent.timestamp).toISOString() : new Date().toISOString();

        setup.onMetadata(platformId, 'Note to Self', false);

        const msg: InboundMessage = {
          id: String(syncSent.timestamp ?? Date.now()),
          kind: 'chat',
          content: {
            text,
            sender: config.account,
            senderId: `signal:${config.account}`,
            senderName: 'Me',
            isFromMe: true,
            ...(syncSent.quote ? quoteToContent(syncSent.quote) : {}),
          },
          timestamp,
        };
        await setup.onInbound(platformId, null, msg);
        return;
      }
      // Other sync messages are our outbound — skip
      return;
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    const rawText = (dataMessage.message ?? '').trim();
    const text = rawText ? resolveMentions(rawText, dataMessage.mentions) : '';

    const audioAttachment = dataMessage.attachments?.find((a) => a.contentType?.startsWith('audio/') && a.id);
    const hasVoice = !text && !!audioAttachment;
    const hasAnyAttachment = (dataMessage.attachments?.length ?? 0) > 0;

    if (!text && !hasVoice && !hasAnyAttachment) return;

    const sender = (envelope.sourceNumber ?? envelope.sourceUuid ?? envelope.source ?? '').trim();
    if (!sender) return;

    const senderName = (envelope.sourceName?.trim() || sender).trim();

    // Modern Signal groups use groupV2; legacy groupInfo.groupId is the
    // pre-V2 fallback. Without the V2 read, V2-only groups appear as DMs
    // because `groupInfo` is undefined.
    const groupInfo = dataMessage.groupInfo;
    const groupId = dataMessage.groupV2?.id ?? groupInfo?.groupId;
    const isGroup = Boolean(groupId);

    const platformId = isGroup ? `group:${groupId}` : sender;

    if (text && echoCache.isEcho(platformId, text)) {
      log.debug('Signal: skipping echo', { platformId });
      return;
    }
    const timestamp = dataMessage.timestamp ? new Date(dataMessage.timestamp).toISOString() : new Date().toISOString();

    const chatName = groupInfo?.groupName ?? (isGroup ? `Group ${groupId?.slice(0, 8)}` : senderName);

    setup.onMetadata(platformId, chatName, isGroup);

    let content = text;
    const cacheDir = join(config.signalDataDir, 'attachments');

    // Voice attachment — try transcription if WHISPER_BIN or OPENAI_API_KEY
    // is configured; otherwise fall back to the placeholder. Transcription
    // reads directly from signal-cli's cache; the file is also offered to
    // the agent through the structured attachments array below so the agent
    // can re-listen if needed.
    if (hasVoice && audioAttachment?.id) {
      const cachedAudio = findCachedAttachment(cacheDir, audioAttachment.id);
      if (cachedAudio) {
        log.info('Signal: voice attachment received', {
          platformId,
          attachmentId: audioAttachment.id,
          path: cachedAudio,
        });
        const transcript = await transcribeAudioOptional(cachedAudio);
        if (transcript) {
          content = `[Voice: ${transcript}]`;
          log.info('Signal: voice transcribed', { platformId, length: transcript.length });
        } else {
          content = '[Voice Message]';
        }
      } else {
        const placeholder = signalCachePlaceholderExists(cacheDir, audioAttachment.id);
        log.warn('Signal: voice attachment cache file unavailable', {
          id: audioAttachment.id,
          cacheDir,
          placeholder,
        });
        content = placeholder ? '[Voice Message - download failed]' : '[Voice Message - file not found]';
      }
    }

    // Build content.attachments[] with base64 payloads. The host's
    // session-manager.extractAttachmentFiles writes each entry's `data` into
    // `<sessionDir>/inbox/<messageId>/<name>` and replaces it with
    // `localPath`, so the agent ultimately reads files from per-session
    // storage instead of the shared signal-cli cache (which is GC'd and
    // cross-group visible). Voice attachments are included so the agent can
    // re-listen even after transcription.
    const attachments: Array<{
      name: string;
      type: string;
      mimeType: string;
      size: number;
      data: string;
    }> = [];

    for (const att of dataMessage.attachments ?? []) {
      if (!att.id) continue;
      const declaredSize = att.size ?? 0;
      if (declaredSize > MAX_ATTACHMENT_BYTES) {
        log.warn('Signal: skipping oversize attachment', {
          id: att.id,
          size: declaredSize,
          max: MAX_ATTACHMENT_BYTES,
        });
        continue;
      }
      const cached = findCachedAttachment(cacheDir, att.id);
      if (!cached) {
        const placeholder = signalCachePlaceholderExists(cacheDir, att.id);
        log.warn(
          placeholder
            ? 'Signal: attachment download failed (0-byte placeholder), skipping'
            : 'Signal: attachment cache file missing, skipping',
          {
            id: att.id,
            cacheDir,
            placeholder,
          },
        );
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(cached);
      } catch (err) {
        log.warn('Signal: failed to read cached attachment, skipping', { id: att.id, cached, err });
        continue;
      }
      if (bytes.length === 0) {
        // Race: findCachedAttachment saw bytes, but the file was rotated
        // between the stat and the read. Treat as placeholder.
        log.warn('Signal: attachment was 0 bytes at read time, skipping', { id: att.id, cached });
        continue;
      }
      const mimeType = att.contentType ?? 'application/octet-stream';
      const name = sanitizeAttachmentName(att.filename, att.id, att.contentType);
      attachments.push({
        name,
        type: mimeType.startsWith('image/')
          ? 'image'
          : mimeType.startsWith('audio/')
            ? 'audio'
            : mimeType.startsWith('video/')
              ? 'video'
              : 'file',
        mimeType,
        size: bytes.length,
        data: bytes.toString('base64'),
      });
    }

    const msg: InboundMessage = {
      id: String(dataMessage.timestamp ?? Date.now()),
      kind: 'chat',
      content: {
        text: content,
        sender,
        senderId: `signal:${sender}`,
        senderName,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(dataMessage.quote ? quoteToContent(dataMessage.quote) : {}),
      },
      timestamp,
    };
    await setup.onInbound(platformId, null, msg);

    log.info('Signal message received', { platformId, sender: senderName });
  }

  /**
   * Build the `replyTo` object the agent-runner formatter expects (see
   * `container/agent-runner/src/formatter.ts:formatReplyContext`). The
   * formatter requires both `sender` and `text` to render the
   * `<quoted_message>` block; absent either, it omits the block entirely.
   *
   * The previous shape (`replyToSenderName` / `replyToMessageContent` /
   * `replyToMessageId` flat keys) did not match the formatter contract, so
   * quote-reply context was silently dropped end-to-end.
   */
  function quoteToContent(quote: SignalQuote): Record<string, unknown> {
    const sender = quote.authorName || quote.authorNumber || quote.author || quote.authorUuid || 'someone';
    const text = quote.text || '';
    return {
      replyTo: {
        id: quote.id ? String(quote.id) : undefined,
        sender,
        text,
      },
    };
  }

  // -- send helpers --

  async function sendText(platformId: string, text: string): Promise<void> {
    if (!connected || !tcp) return;

    echoCache.remember(platformId, text);

    const MAX_CHUNK = 4000;
    const chunks = text.length <= MAX_CHUNK ? [text] : chunkText(text, MAX_CHUNK);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const { text: plainText, textStyles } = parseSignalStyles(chunk);
      const params: Record<string, unknown> = { message: plainText };
      if (config.account) params.account = config.account;
      if (textStyles.length > 0) {
        params.textStyle = textStyles.map((s) => `${s.start}:${s.length}:${s.style}`);
      }

      if (platformId.startsWith('group:')) {
        params.groupId = platformId.slice('group:'.length);
      } else {
        params.recipient = [platformId];
      }

      // Two retry layers stack here:
      //  1. textStyle-rejection fallback (one-shot): if signal-cli rejects the
      //     style params, retry without them so unstyled text still lands.
      //  2. transient-failure retry loop: if a send hits a retryable network
      //     error (UND_ERR_SOCKET, PushNetworkException, etc.), back off and
      //     retry. Exhaust → propagate so the delivery layer can record the
      //     failure in dropped_messages.
      const maxRetries = SEND_BACKOFF_MS.length;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          try {
            await tcp.rpc('send', params);
          } catch (styledErr) {
            if (textStyles.length > 0) {
              log.debug('Signal: textStyle rejected, retrying without styles');
              delete params.textStyle;
              params.message = chunk;
              await tcp.rpc('send', params);
            } else {
              throw styledErr;
            }
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isRetryableSendError(err) || attempt >= maxRetries) break;
          const baseDelay = SEND_BACKOFF_MS[attempt]!;
          const stale = isStaleConnectionError(err);
          const delay = stale ? Math.max(baseDelay, STALE_CONNECTION_MIN_DELAY_MS) : baseDelay;
          log.warn('Signal: transient send error, retrying', {
            platformId,
            chunkIndex: i,
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            stale,
            err: errMessage(err),
          });
          await sleepMs(delay);
        }
      }

      if (lastErr) {
        // Propagate so the delivery layer (src/delivery.ts) sees the failure
        // and routes it through MAX_DELIVERY_ATTEMPTS / markDeliveryFailed.
        // Previous behaviour swallowed the error and logged a false-success
        // "Signal message sent" below, making delivery failures invisible.
        log.error('Signal: send failed', { platformId, chunkIndex: i, err: errMessage(lastErr) });
        throw lastErr;
      }
    }

    log.info('Signal message sent', { platformId, length: text.length });
  }

  /**
   * Send one or more file attachments via signal-cli's `send` JSON-RPC, which
   * accepts an `attachments` array of host filesystem paths. The OutboundFile
   * Buffer is materialized to an OS temp file so signal-cli can read it, then
   * removed in the finally block.
   *
   * Caption text, if any, is sent first via `sendText` (which handles chunking
   * + textStyles) — keeps this function single-purpose and avoids a long
   * caption colliding with signal-cli's per-message size limits.
   */
  async function sendAttachments(platformId: string, files: { filename: string; data: Buffer }[]): Promise<void> {
    if (!connected || !tcp) return;
    if (files.length === 0) return;

    const tempPaths: string[] = [];
    for (const file of files) {
      const safeName = file.filename.replace(/[/\\\0]/g, '_');
      const tempPath = join(tmpdir(), `signal-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
      writeFileSync(tempPath, file.data);
      tempPaths.push(tempPath);
    }

    try {
      const params: Record<string, unknown> = { attachments: tempPaths };
      if (config.account) params.account = config.account;
      if (platformId.startsWith('group:')) {
        params.groupId = platformId.slice('group:'.length);
      } else {
        params.recipient = [platformId];
      }

      // Attachment sends get a longer retry budget than text sends. Push
      // connections drop more often when the host is uploading bytes, and
      // signal-cli's ReceiveHelper needs several seconds under load before
      // the next attempt has a fresh socket. See ATTACHMENT_SEND_BACKOFF_MS.
      const maxRetries = ATTACHMENT_SEND_BACKOFF_MS.length;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await tcp.rpc('send', params);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isRetryableSendError(err) || attempt >= maxRetries) break;
          const baseDelay = ATTACHMENT_SEND_BACKOFF_MS[attempt]!;
          const stale = isStaleConnectionError(err);
          const delay = stale ? Math.max(baseDelay, STALE_CONNECTION_MIN_DELAY_MS) : baseDelay;
          log.warn('Signal: transient attachment send error, retrying', {
            platformId,
            count: files.length,
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            stale,
            err: errMessage(err),
          });
          await sleepMs(delay);
        }
      }

      if (lastErr) {
        // Propagate so src/delivery.ts records the failure rather than
        // silently dropping bytes the user paid for in upload time.
        log.error('Signal: attachment send failed', {
          platformId,
          count: files.length,
          err: errMessage(lastErr),
        });
        throw lastErr;
      }

      log.info('Signal attachments sent', { platformId, count: files.length, filenames: files.map((f) => f.filename) });
    } finally {
      for (const p of tempPaths) {
        try {
          unlinkSync(p);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  async function waitForDaemon(): Promise<boolean> {
    const maxWait = 30_000;
    const pollInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (daemon?.isExited()) return false;
      const ok = await signalTcpCheck(config.tcpHost, config.tcpPort);
      if (ok) return true;
      await sleep(pollInterval);
    }
    return false;
  }

  // -- adapter --

  const adapter: ChannelAdapter = {
    name: 'signal',
    channelType: 'signal',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;

      if (config.manageDaemon) {
        daemon = spawnSignalDaemon(config.cliPath, config.account, config.tcpHost, config.tcpPort);
        const ready = await waitForDaemon();
        if (!ready) {
          daemon.stop();
          throw new Error('Signal daemon failed to start. Is signal-cli installed and your account linked?');
        }
      } else {
        const ok = await signalTcpCheck(config.tcpHost, config.tcpPort);
        if (!ok) {
          const err = new Error(
            `Signal daemon not reachable at ${config.tcpHost}:${config.tcpPort}. Start it manually or set SIGNAL_MANAGE_DAEMON=true`,
          );
          (err as any).name = 'NetworkError';
          throw err;
        }
      }

      tcp = new SignalTcpClient(config.tcpHost, config.tcpPort);
      await tcp.connect({
        onNotification: handleNotification,
        // Signal the adapter that the daemon dropped us. No auto-reconnect yet
        // — subsequent deliver/setTyping calls short-circuit on `connected`
        // and log rather than throw into the retry loop. Operators see this in
        // logs/nanoclaw.log and can restart the service.
        onClose: () => {
          if (!connected) return;
          connected = false;
          log.warn('Signal channel lost TCP connection to signal-cli daemon', {
            account: config.account,
            host: config.tcpHost,
            port: config.tcpPort,
          });
        },
      });

      try {
        await tcp.rpc('updateProfile', {
          name: 'NanoClaw',
          account: config.account,
        });
      } catch {
        log.debug('Signal: could not set profile name');
      }

      try {
        await tcp.rpc('updateConfiguration', {
          typingIndicators: true,
          account: config.account,
        });
      } catch {
        log.debug('Signal: could not enable typing indicators');
      }

      connected = true;
      log.info('Signal channel connected', {
        account: config.account,
        host: config.tcpHost,
        port: config.tcpPort,
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      tcp?.close();
      tcp = null;
      if (daemon && config.manageDaemon) {
        daemon.stop();
        await daemon.exited;
      }
      daemon = null;
      log.info('Signal channel disconnected');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown> | string | undefined;
      let text: string | null = null;
      if (typeof content === 'string') {
        text = content;
      } else if (content && typeof content === 'object' && typeof content.text === 'string') {
        text = content.text;
      }

      const files = message.files ?? [];

      // Host-side outbound dedupe. Guards against the delivery layer
      // re-invoking deliver after our own RPC timeout fired but signal-cli
      // had already pushed the message — see isRetryableSendError's note on
      // 'Signal RPC timeout:'. Keys include files (fingerprint by name+size)
      // so the same caption text attached to two different files does not
      // collapse.
      const filesFingerprint = files.map((f) => `${f.filename}:${f.data.byteLength}`);
      if (!sendDedupe.tryRecord(platformId, text ?? '', filesFingerprint)) {
        log.debug('Signal: skipping duplicate outbound delivery', {
          platformId,
          textLength: text?.length ?? 0,
          fileCount: files.length,
        });
        return undefined;
      }

      // Send accompanying text first so it lands above the attachment(s) in
      // the recipient's chat. Both branches no-op cleanly if their input is
      // empty, so any combination of (text, files) works.
      if (text) await sendText(platformId, text);
      if (files.length > 0) await sendAttachments(platformId, files);
      return undefined;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!connected || !tcp) return;
      if (platformId.startsWith('group:')) return;

      try {
        const params: Record<string, unknown> = { recipient: [platformId] };
        if (config.account) params.account = config.account;
        await tcp.rpc('sendTyping', params);
      } catch (err) {
        log.debug('Signal: typing indicator failed', { platformId, err });
      }
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

const DEFAULT_TCP_HOST = '127.0.0.1';
const DEFAULT_TCP_PORT = 7583;

registerChannelAdapter('signal', {
  factory: () => {
    const envVars = readEnvFile([
      'SIGNAL_ACCOUNT',
      'SIGNAL_TCP_HOST',
      'SIGNAL_TCP_PORT',
      'SIGNAL_CLI_PATH',
      'SIGNAL_MANAGE_DAEMON',
      'SIGNAL_DATA_DIR',
    ]);

    const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
    if (!account) {
      log.debug('Signal: SIGNAL_ACCOUNT not set, skipping channel');
      return null;
    }

    const cliPath = process.env.SIGNAL_CLI_PATH || envVars.SIGNAL_CLI_PATH || 'signal-cli';
    const tcpHost = process.env.SIGNAL_TCP_HOST || envVars.SIGNAL_TCP_HOST || DEFAULT_TCP_HOST;
    const tcpPort = parseInt(process.env.SIGNAL_TCP_PORT || envVars.SIGNAL_TCP_PORT || String(DEFAULT_TCP_PORT), 10);
    const manageDaemon = (process.env.SIGNAL_MANAGE_DAEMON || envVars.SIGNAL_MANAGE_DAEMON || 'true') === 'true';

    const signalDataDir =
      process.env.SIGNAL_DATA_DIR || envVars.SIGNAL_DATA_DIR || join(homedir(), '.local', 'share', 'signal-cli');

    // Only check for `signal-cli` on PATH when the operator left cliPath at
    // the default AND asked us to manage the daemon. A custom absolute path
    // is treated as an explicit promise and spawn will surface its own ENOENT.
    if (manageDaemon && cliPath === 'signal-cli') {
      try {
        execFileSync('which', ['signal-cli'], { stdio: 'ignore' });
      } catch {
        log.debug('Signal: signal-cli binary not found, skipping channel');
        return null;
      }
    }

    return createSignalAdapter({
      cliPath,
      account,
      tcpHost,
      tcpPort,
      manageDaemon,
      signalDataDir,
    });
  },
});
