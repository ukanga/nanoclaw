import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks ---

vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

// --- TCP socket mock ---

import { EventEmitter } from 'events';

const tcpRef = vi.hoisted(() => ({
  rpcResponses: new Map<string, unknown>(),
  fakeSocket: null as any,
}));

function createFakeSocket(): EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
} {
  const sock = new EventEmitter() as any;
  sock.destroyed = false;
  sock.destroy = vi.fn(() => {
    sock.destroyed = true;
    sock.emit('close');
  });
  sock.write = vi.fn((data: string) => {
    try {
      const req = JSON.parse(data.trim());
      const result = tcpRef.rpcResponses.get(req.method) ?? { ok: true };
      const response = JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n';
      setImmediate(() => sock.emit('data', Buffer.from(response)));
    } catch {
      /* ignore */
    }
  });
  return sock;
}

vi.mock('node:net', () => ({
  createConnection: vi.fn((_port: number, _host: string, cb?: () => void) => {
    const sock = createFakeSocket();
    tcpRef.fakeSocket = sock;
    if (cb) setImmediate(cb);
    return sock;
  }),
}));

import type { ChannelSetup } from './adapter.js';
import { createSignalAdapter } from './signal.js';

// --- Test helpers ---

function createMockSetup() {
  return {
    onInbound: vi.fn() as unknown as ChannelSetup['onInbound'] & ReturnType<typeof vi.fn>,
    onInboundEvent: vi.fn() as unknown as ChannelSetup['onInboundEvent'] & ReturnType<typeof vi.fn>,
    onMetadata: vi.fn() as unknown as ChannelSetup['onMetadata'] & ReturnType<typeof vi.fn>,
    onAction: vi.fn() as unknown as ChannelSetup['onAction'] & ReturnType<typeof vi.fn>,
  };
}

function createAdapter() {
  return createSignalAdapter({
    cliPath: 'signal-cli',
    account: '+15551234567',
    tcpHost: '127.0.0.1',
    tcpPort: 7583,
    manageDaemon: false,
    signalDataDir: '/tmp/signal-cli-test-data',
  });
}

function getRpcCalls(): Array<{
  method: string;
  params: Record<string, unknown>;
  id: string;
}> {
  if (!tcpRef.fakeSocket) return [];
  return tcpRef.fakeSocket.write.mock.calls
    .map((c: any[]) => {
      try {
        return JSON.parse(c[0].trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getRpcCallsForMethod(method: string) {
  return getRpcCalls().filter((c) => c.method === method);
}

function pushEvent(envelope: Record<string, unknown>) {
  if (!tcpRef.fakeSocket) throw new Error('TCP socket not connected');
  const notification =
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: { envelope },
    }) + '\n';
  tcpRef.fakeSocket.emit('data', Buffer.from(notification));
}

// --- Tests ---

describe('SignalAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tcpRef.rpcResponses.clear();
    tcpRef.fakeSocket = null;
    tcpRef.rpcResponses.set('send', { timestamp: 1234567890 });
    tcpRef.rpcResponses.set('sendTyping', {});
  });

  afterEach(() => {
    try {
      tcpRef.fakeSocket?.destroy();
    } catch {
      // already closed
    }
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects when daemon is reachable', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      expect(adapter.isConnected()).toBe(true);
      expect(tcpRef.fakeSocket).not.toBeNull();

      await adapter.teardown();
    });

    it('isConnected() returns false before setup', () => {
      const adapter = createAdapter();
      expect(adapter.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      expect(adapter.isConnected()).toBe(true);

      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('throws NetworkError if daemon is unreachable', async () => {
      const { createConnection } = await import('node:net');
      vi.mocked(createConnection).mockImplementationOnce((...args: any[]) => {
        const sock = createFakeSocket();
        setImmediate(() => sock.emit('error', new Error('Connection refused')));
        return sock as any;
      });

      const adapter = createAdapter();
      await expect(adapter.setup(createMockSetup())).rejects.toThrow(/not reachable/);
    });
  });

  // --- Inbound message handling ---

  describe('inbound message handling', () => {
    it('delivers DM via onInbound', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Hello from Signal',
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(cfg.onMetadata).toHaveBeenCalledWith('+15555550123', 'Alice', false);
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({
          id: '1700000000000',
          kind: 'chat',
          content: expect.objectContaining({
            text: 'Hello from Signal',
            sender: '+15555550123',
            senderName: 'Alice',
          }),
        }),
      );

      await adapter.teardown();
    });

    it('delivers group message with group platformId', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550999',
        sourceName: 'Bob',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Group hello',
          groupInfo: { groupId: 'abc123', groupName: 'Family' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(cfg.onMetadata).toHaveBeenCalledWith('group:abc123', 'Family', true);
      expect(cfg.onInbound).toHaveBeenCalledWith(
        'group:abc123',
        null,
        expect.objectContaining({
          content: expect.objectContaining({
            text: 'Group hello',
            sender: '+15555550999',
          }),
        }),
      );

      await adapter.teardown();
    });

    it('skips sync messages (own outbound)', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15551234567',
        syncMessage: {
          sentMessage: {
            timestamp: 1700000000000,
            message: 'My own message',
            destination: '+15555550123',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });

    it('processes Note to Self sync messages as inbound', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15551234567',
        syncMessage: {
          sentMessage: {
            timestamp: 1700000000000,
            message: 'Hello Bee',
            destinationNumber: '+15551234567',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15551234567',
        null,
        expect.objectContaining({
          content: expect.objectContaining({
            text: 'Hello Bee',
            senderName: 'Me',
            isFromMe: true,
          }),
        }),
      );

      await adapter.teardown();
    });

    it('skips empty messages', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: '   ' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });

    it('skips echoed outbound messages', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Echo test' },
      });

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: 'Echo test' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });

    // Inbound attachment cases (image, audio, oversize, 0-byte, missing,
    // unsafe filename, double-extension) live in the
    // `inbound attachment materialization` describe block below. The old
    // `[Image: <cache-path>]` test was removed when the adapter switched to
    // content.attachments[] with base64.
  });

  // --- Inbound attachment materialization ---

  describe('inbound attachment materialization', () => {
    let tmpDataDir: string;
    let cacheDir: string;

    beforeEach(() => {
      tmpDataDir = mkdtempSync(join(tmpdir(), 'signal-attach-test-'));
      cacheDir = join(tmpDataDir, 'attachments');
      mkdirSync(cacheDir, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    function createAdapterWithCache() {
      return createSignalAdapter({
        cliPath: 'signal-cli',
        account: '+15551234567',
        tcpHost: '127.0.0.1',
        tcpPort: 7583,
        manageDaemon: false,
        signalDataDir: tmpDataDir,
      });
    }

    it('materializes a base64 image attachment with a sanitized name', async () => {
      const id = 'imgABCD';
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      writeFileSync(join(cacheDir, id), bytes);

      const adapter = createAdapterWithCache();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'check this out',
          attachments: [{ id, contentType: 'image/png', filename: 'fancy pic.png', size: bytes.length }],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(cfg.onInbound).toHaveBeenCalledTimes(1);
      const inboundArg = (cfg.onInbound as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(inboundArg.content.text).toBe('check this out');
      expect(inboundArg.content.text).not.toMatch(/\[Image:/);
      expect(inboundArg.content.attachments).toEqual([
        expect.objectContaining({
          name: 'fancy_pic.png',
          type: 'image',
          mimeType: 'image/png',
          size: bytes.length,
          data: bytes.toString('base64'),
        }),
      ]);

      await adapter.teardown();
    });

    it('does not double-extension when the signal-cli id already carries one', async () => {
      // Reproduces the v1 bug fixed by commit 62c6f36: signal-cli ids of the
      // form `wx58uQ.png` were producing `attachment-wx58uQ.png.png`.
      const id = 'wx58uQ.png';
      const bytes = Buffer.from('fake png bytes');
      writeFileSync(join(cacheDir, id), bytes);

      const adapter = createAdapterWithCache();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'photo',
          // filename intentionally omitted — sanitizer falls back to attachment-<id>
          attachments: [{ id, contentType: 'image/png', size: bytes.length }],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const inboundArg = (cfg.onInbound as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      const name = inboundArg.content.attachments[0].name as string;
      expect(name).not.toMatch(/\.png\.png$/);
      expect(name).toBe('attachment-wx58uQ.png');

      await adapter.teardown();
    });

    it('skips an oversize attachment while keeping a sibling under the cap', async () => {
      // The oversize check fires off the declared `size` field before the
      // file is even read, so we don't need to actually write 25MB on disk.
      const bigId = 'bigFile';
      writeFileSync(join(cacheDir, bigId), Buffer.from('x'));

      const okId = 'okFile';
      const okBytes = Buffer.from('small payload');
      writeFileSync(join(cacheDir, okId), okBytes);

      const adapter = createAdapterWithCache();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'two attachments',
          attachments: [
            {
              id: bigId,
              contentType: 'application/pdf',
              filename: 'huge.pdf',
              size: 30 * 1024 * 1024,
            },
            { id: okId, contentType: 'text/plain', filename: 'small.txt', size: okBytes.length },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const inboundArg = (cfg.onInbound as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(inboundArg.content.attachments).toHaveLength(1);
      expect(inboundArg.content.attachments[0].name).toBe('small.txt');

      await adapter.teardown();
    });

    it('drops a 0-byte placeholder attachment and warns with placeholder: true', async () => {
      const { log } = (await import('../log.js')) as { log: { warn: ReturnType<typeof vi.fn> } };
      const id = 'failedDownload';
      writeFileSync(join(cacheDir, id), Buffer.alloc(0));

      const adapter = createAdapterWithCache();
      const cfg = createMockSetup();
      await adapter.setup(cfg);
      (log.warn as ReturnType<typeof vi.fn>).mockClear();

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: {
          timestamp: 1700000000000,
          // No text — this attachment is the only payload, so when it's
          // dropped the adapter has nothing to forward.
          attachments: [{ id, contentType: 'image/png', filename: 'broken.png', size: 1234 }],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(cfg.onInbound).not.toHaveBeenCalled();
      const warnedWithPlaceholder = (log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        (call) => (call[1] as { placeholder?: boolean } | undefined)?.placeholder === true,
      );
      expect(warnedWithPlaceholder).toBe(true);

      await adapter.teardown();
    });

    it('skips silently with a warn when no cache file exists for the id', async () => {
      const { log } = (await import('../log.js')) as { log: { warn: ReturnType<typeof vi.fn> } };
      const id = 'neverDownloaded';
      // Do NOT write any file for `id`.

      const adapter = createAdapterWithCache();
      const cfg = createMockSetup();
      await adapter.setup(cfg);
      (log.warn as ReturnType<typeof vi.fn>).mockClear();

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: {
          timestamp: 1700000000000,
          attachments: [{ id, contentType: 'image/jpeg', filename: 'pic.jpg', size: 1024 }],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(cfg.onInbound).not.toHaveBeenCalled();
      const warnedMissing = (log.warn as ReturnType<typeof vi.fn>).mock.calls.some((call) => {
        const msg = String(call[0]);
        const ctx = call[1] as { placeholder?: boolean } | undefined;
        return /attachment cache file missing/.test(msg) && ctx?.placeholder === false;
      });
      expect(warnedMissing).toBe(true);

      await adapter.teardown();
    });

    it('sanitizes a path-traversal filename', async () => {
      const id = 'sneaky';
      const bytes = Buffer.from('payload');
      writeFileSync(join(cacheDir, id), bytes);

      const adapter = createAdapterWithCache();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'evil',
          attachments: [
            {
              id,
              contentType: 'application/octet-stream',
              filename: '../../etc/passwd',
              size: bytes.length,
            },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const name = (cfg.onInbound as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2].content.attachments[0]
        .name as string;
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toMatch(/\.\./);

      await adapter.teardown();
    });

    it('emits a voice-only message with [Voice Message] text and the audio attachment', async () => {
      const id = 'voiceClip';
      const bytes = Buffer.from('fake-ogg-bytes');
      writeFileSync(join(cacheDir, id), bytes);

      const adapter = createAdapterWithCache();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          // No message text — voice-only envelope.
          attachments: [{ id, contentType: 'audio/ogg', size: bytes.length }],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const inboundArg = (cfg.onInbound as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      // No WHISPER_BIN / OPENAI_API_KEY in this test env, so transcription
      // falls back to the placeholder text.
      expect(inboundArg.content.text).toBe('[Voice Message]');
      expect(inboundArg.content.attachments).toEqual([
        expect.objectContaining({ type: 'audio', mimeType: 'audio/ogg' }),
      ]);

      await adapter.teardown();
    });
  });

  // --- groupV2 ---

  describe('group routing', () => {
    it('routes to groupV2.id when present, falling back to legacy groupInfo.groupId', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'hello v2',
          groupV2: { id: 'v2group=' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith('group:v2group=', null, expect.anything());

      await adapter.teardown();
    });
  });

  // --- mention resolution ---

  describe('mention detection (isMention flag)', () => {
    it('sets isMention=true on DMs unconditionally', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: { timestamp: 1700000000001, message: 'hi' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({ isMention: true, isGroup: false }),
      );

      await adapter.teardown();
    });

    it('sets isMention=true in a group when bot account is in mentions[]', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000002,
          message: '￼ ping',
          mentions: [{ start: 0, length: 1, name: 'Bot', number: '+15551234567', uuid: 'bot-uuid' }],
          groupV2: { id: 'AAAA' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        'group:AAAA',
        null,
        expect.objectContaining({ isMention: true, isGroup: true }),
      );

      await adapter.teardown();
    });

    it('sets isMention=false in a group when bot is not mentioned', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000003,
          message: 'just talking',
          groupV2: { id: 'BBBB' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        'group:BBBB',
        null,
        expect.objectContaining({ isMention: false, isGroup: true }),
      );

      await adapter.teardown();
    });

    it('does not match when only a different account is mentioned in a group', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000004,
          message: '￼ hey',
          mentions: [{ start: 0, length: 1, name: 'Carol', number: '+15559998888' }],
          groupV2: { id: 'CCCC' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        'group:CCCC',
        null,
        expect.objectContaining({ isMention: false, isGroup: true }),
      );

      await adapter.teardown();
    });
  });

  describe('mention resolution', () => {
    it('replaces inline mention placeholders with display names', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'hey ￼ are you here?',
          mentions: [{ start: 4, length: 1, name: 'Bob', uuid: 'bob-uuid' }],
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'hey @Bob are you here?' }),
        }),
      );

      await adapter.teardown();
    });
  });

  // --- Quote context ---

  describe('quote context', () => {
    it('emits a nested replyTo object matching the formatter contract', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'I disagree',
          quote: {
            id: 1699999999000,
            authorNumber: '+15555550888',
            authorName: 'Pineapple Pete',
            text: 'Pineapple belongs on pizza',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({
          content: expect.objectContaining({
            text: 'I disagree',
            replyTo: {
              id: '1699999999000',
              sender: 'Pineapple Pete',
              text: 'Pineapple belongs on pizza',
            },
          }),
        }),
      );

      await adapter.teardown();
    });
  });

  // --- deliver ---

  describe('deliver', () => {
    it('sends DM via TCP RPC', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(0);

      const last = sendCalls[sendCalls.length - 1];
      expect(last.params).toEqual(
        expect.objectContaining({
          recipient: ['+15555550123'],
          message: 'Hello',
          account: '+15551234567',
        }),
      );

      await adapter.teardown();
    });

    it('sends group message via groupId', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.deliver('group:abc123', null, {
        kind: 'text',
        content: { text: 'Group msg' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params).toEqual(
        expect.objectContaining({
          groupId: 'abc123',
          message: 'Group msg',
        }),
      );

      await adapter.teardown();
    });

    it('chunks long messages', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      const longText = 'x'.repeat(5000);
      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: longText },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(1);

      await adapter.teardown();
    });

    it('extracts text from string content', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: 'Plain string content',
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(0);
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Plain string content');

      await adapter.teardown();
    });
  });

  // --- Outbound attachments ---

  describe('deliver — attachments', () => {
    // Real fs writes happen in tmpdir(); confirm the bytes round-trip and
    // are cleaned up after deliver returns.
    it('sends a single attachment via attachments[] param', async () => {
      const fs = await import('node:fs');
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: {},
        files: [{ filename: 'report.md', data: Buffer.from('# Report\n\nbody') }],
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBe(1);
      const params = sendCalls[0].params as Record<string, unknown>;
      expect(params.recipient).toEqual(['+15555550123']);
      expect(params.account).toBe('+15551234567');
      expect(params.message).toBeUndefined();
      const paths = params.attachments as string[];
      expect(paths).toHaveLength(1);
      // Each attachment lives in its own mkdtemp dir so the recipient sees
      // the clean basename (no signal-out-... prefix on the filename itself).
      expect(paths[0]).toMatch(/signal-out-[a-zA-Z0-9]+\/report\.md$/);
      // Temp file should no longer exist — finally{} cleanup ran
      expect(fs.existsSync(paths[0])).toBe(false);

      await adapter.teardown();
    });

    it('combines short caption + attachment into a single send RPC', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: { text: 'Here is the digest' },
        files: [{ filename: 'digest.md', data: Buffer.from('content') }],
      });

      // One bubble: signal-cli renders message + attachments[] as a single
      // Signal message with the caption beneath the file.
      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls).toHaveLength(1);
      const params = sendCalls[0].params as Record<string, unknown>;
      expect(params.message).toBe('Here is the digest');
      expect(params.recipient).toEqual(['+15555550123']);
      const attachments = params.attachments as string[];
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatch(/\/digest\.md$/);

      await adapter.teardown();
    });

    it('falls back to separate text + attachment sends when caption exceeds chunk size', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      const longCaption = 'x'.repeat(5000);
      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: { text: longCaption },
        files: [{ filename: 'big.md', data: Buffer.from('content') }],
      });

      // chunkText produces 2 text sends (4000 + 1000), then 1 captionless
      // attachment send.
      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls).toHaveLength(3);
      expect((sendCalls[0].params as Record<string, unknown>).attachments).toBeUndefined();
      expect((sendCalls[1].params as Record<string, unknown>).attachments).toBeUndefined();
      const last = sendCalls[2].params as Record<string, unknown>;
      expect(last.message).toBeUndefined();
      expect((last.attachments as string[]).length).toBe(1);

      await adapter.teardown();
    });

    it('sends multiple attachments in a single send call', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: {},
        files: [
          { filename: 'a.txt', data: Buffer.from('a') },
          { filename: 'b.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        ],
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls).toHaveLength(1);
      const attachments = (sendCalls[0].params as Record<string, unknown>).attachments as string[];
      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toMatch(/\/a\.txt$/);
      expect(attachments[1]).toMatch(/\/b\.png$/);

      await adapter.teardown();
    });

    it('uses groupId for group destinations', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('group:abc123', null, {
        kind: 'file',
        content: {},
        files: [{ filename: 'pic.jpg', data: Buffer.from('jpg') }],
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls).toHaveLength(1);
      const params = sendCalls[0].params as Record<string, unknown>;
      expect(params.groupId).toBe('abc123');
      expect(params.recipient).toBeUndefined();

      await adapter.teardown();
    });

    /**
     * Defensive test: `OutboundFile.filename` is operator-supplied data, so
     * the implementation must not let a filename containing path separators
     * escape the temp directory. We feed an attempt-to-traverse filename and
     * assert the resolved path stays strictly inside `tmpdir()`.
     */
    it('keeps temp paths inside tmpdir even when filename contains path separators', async () => {
      const path = await import('node:path');
      const os = await import('node:os');
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: {},
        files: [{ filename: '../sneaky.txt', data: Buffer.from('x') }],
      });

      const sendCalls = getRpcCallsForMethod('send');
      const paths = (sendCalls[0].params as Record<string, unknown>).attachments as string[];
      const resolvedTmp = path.resolve(os.tmpdir());
      const resolvedResult = path.resolve(paths[0]);
      // path.resolve normalizes away any "../"; if sanitization failed, the
      // result would resolve to tmpdir's parent.
      expect(resolvedResult.startsWith(resolvedTmp + path.sep)).toBe(true);

      await adapter.teardown();
    });
  });

  // --- Text styles ---

  describe('text styles', () => {
    it('sends bold text with textStyle parameter', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello **world**' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(0);
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Hello world');
      expect(last.params.textStyle).toEqual(['6:5:BOLD']);

      await adapter.teardown();
    });

    it('sends inline code with MONOSPACE style', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Run `npm test` now' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Run npm test now');
      expect(last.params.textStyle).toEqual(['4:8:MONOSPACE']);

      await adapter.teardown();
    });

    it('sends plain text without textStyle', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'No formatting here' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('No formatting here');
      expect(last.params.textStyle).toBeUndefined();

      await adapter.teardown();
    });

    it('falls back to original markup when textStyle is rejected', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      let sendCount = 0;
      tcpRef.fakeSocket.write.mockImplementation((data: string) => {
        try {
          const req = JSON.parse(data.trim());
          if (req.method === 'send') {
            sendCount++;
            if (sendCount === 1) {
              const response =
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  error: { message: 'Unknown parameter: textStyle' },
                }) + '\n';
              setImmediate(() => tcpRef.fakeSocket.emit('data', Buffer.from(response)));
              return;
            }
          }
          const response =
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { ok: true },
            }) + '\n';
          setImmediate(() => tcpRef.fakeSocket.emit('data', Buffer.from(response)));
        } catch {
          /* ignore */
        }
      });

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello **world**' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBe(2);
      expect(sendCalls[1].params.message).toBe('Hello **world**');
      expect(sendCalls[1].params.textStyle).toBeUndefined();

      await adapter.teardown();
    });

    it('tracks nested styles with correct offsets', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: '**bold with `code` inside**' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('bold with code inside');
      // BOLD covers the full inner span, MONOSPACE points at "code" in the
      // final plain text (offset 10, length 4) — not the intermediate text.
      const styles = (last.params.textStyle as string[]).slice().sort();
      expect(styles).toEqual(['0:21:BOLD', '10:4:MONOSPACE']);

      await adapter.teardown();
    });

    it('maps *single-asterisk* to ITALIC', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello *world*' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Hello world');
      expect(last.params.textStyle).toEqual(['6:5:ITALIC']);

      await adapter.teardown();
    });

    it('maps _underscore_ to ITALIC', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'hey _there_' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('hey there');
      expect(last.params.textStyle).toEqual(['4:5:ITALIC']);

      await adapter.teardown();
    });
  });

  // --- Echo cache ---

  describe('echo cache', () => {
    it('does not drop same-text inbound from a different recipient', async () => {
      // Bot sends "Hello" to Alice. Immediately after, Bob sends "Hello" from
      // a different DM. Bob's message must still route — the earlier echo key
      // was scoped to Alice.
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello' },
      });

      pushEvent({
        sourceNumber: '+15555550999',
        sourceName: 'Bob',
        dataMessage: { timestamp: 1700000000000, message: 'Hello' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550999',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'Hello', sender: '+15555550999' }),
        }),
      );

      await adapter.teardown();
    });

    it('still skips echo on the same recipient', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Echo test' },
      });

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: 'Echo test' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });
  });

  // --- Send retry + outbound dedupe ---

  describe('send retry + outbound dedupe', () => {
    /**
     * Override fakeSocket.write so the Nth `send` call sees a custom outcome.
     * outcomes[i] is the (zero-indexed) attempt response: either { error: msg }
     * to make signal-cli reply with a JSON-RPC error, or { result: any } to
     * succeed. Subsequent attempts beyond outcomes.length default to success.
     */
    function programSendOutcomes(outcomes: Array<{ error: string } | { result: unknown }>): {
      sendCount: () => number;
    } {
      let sendCount = 0;
      tcpRef.fakeSocket.write.mockImplementation((data: string) => {
        try {
          const req = JSON.parse(data.trim());
          // Emit synchronously so the rpc Promise settles before the next
          // fake-timer advance can fire RPC_TIMEOUT_MS. setImmediate-real
          // does not interleave with vi.advanceTimersByTimeAsync.
          if (req.method === 'send') {
            const outcome = outcomes[sendCount] ?? { result: { ok: true } };
            sendCount++;
            const payload =
              'error' in outcome
                ? { jsonrpc: '2.0', id: req.id, error: { message: outcome.error } }
                : { jsonrpc: '2.0', id: req.id, result: outcome.result };
            tcpRef.fakeSocket.emit('data', Buffer.from(JSON.stringify(payload) + '\n'));
            return;
          }
          const fallback = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\n';
          tcpRef.fakeSocket.emit('data', Buffer.from(fallback));
        } catch {
          /* ignore */
        }
      });
      return { sendCount: () => sendCount };
    }

    it('retries on transient send error and succeeds on the retry', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      const tracker = programSendOutcomes([{ error: 'UND_ERR_SOCKET' }, { result: { ok: true } }]);

      const deliverPromise = adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'hi' },
      });
      // Advance past SEND_BACKOFF_MS[0] = 2000ms
      await vi.advanceTimersByTimeAsync(2000);
      await deliverPromise;

      expect(tracker.sendCount()).toBe(2);

      vi.useRealTimers();
      await adapter.teardown();
    });

    it('does NOT retry our own RPC timeout — signal-cli may have delivered', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      const tracker = programSendOutcomes([{ error: 'Signal RPC timeout: send' }, { result: { ok: true } }]);

      await expect(adapter.deliver('+15555550123', null, { kind: 'text', content: { text: 'hi' } })).rejects.toThrow(
        /Signal RPC timeout: send/,
      );

      expect(tracker.sendCount()).toBe(1);

      vi.useRealTimers();
      await adapter.teardown();
    });

    it('exhausts retries on persistent failure and propagates to caller', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      // 3 errors = initial attempt + 2 retries from SEND_BACKOFF_MS, all fail.
      const tracker = programSendOutcomes([
        { error: 'UND_ERR_SOCKET' },
        { error: 'UND_ERR_SOCKET' },
        { error: 'UND_ERR_SOCKET' },
      ]);

      const deliverPromise = adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'hi' },
      });
      // Suppress the unhandled-rejection visibility; we assert via await below.
      deliverPromise.catch(() => {});
      // 2s for attempt 0 → 1; 5s for attempt 1 → 2
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(deliverPromise).rejects.toThrow(/UND_ERR_SOCKET/);

      expect(tracker.sendCount()).toBe(3);

      vi.useRealTimers();
      await adapter.teardown();
    });

    it('attachment send uses the longer ATTACHMENT_SEND_BACKOFF_MS budget', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      // 5 errors = initial attempt + 4 retries from ATTACHMENT_SEND_BACKOFF_MS.
      const tracker = programSendOutcomes([
        { error: 'PushNetworkException' },
        { error: 'PushNetworkException' },
        { error: 'PushNetworkException' },
        { error: 'PushNetworkException' },
        { error: 'PushNetworkException' },
      ]);

      const deliverPromise = adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: {},
        files: [{ filename: 'r.md', data: Buffer.from('x') }],
      });
      deliverPromise.catch(() => {});
      // Stale-connection floor lifts each delay to >= 15s. Advance past all
      // four backoff slots accordingly.
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000);
      await expect(deliverPromise).rejects.toThrow(/PushNetworkException/);

      expect(tracker.sendCount()).toBe(5);

      vi.useRealTimers();
      await adapter.teardown();
    });

    it('floors retry delay to STALE_CONNECTION_MIN_DELAY_MS on stale-connection errors', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { log } = (await import('../log.js')) as { log: { warn: ReturnType<typeof vi.fn> } };
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();
      (log.warn as ReturnType<typeof vi.fn>).mockClear();

      programSendOutcomes([{ error: 'bad_record_mac' }, { result: { ok: true } }]);

      const deliverPromise = adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'hi' },
      });
      // Stale-floor lifts the first delay from 2000 to 15000ms.
      await vi.advanceTimersByTimeAsync(15_000);
      await deliverPromise;

      const retryLog = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        String(c[0]).includes('transient send error'),
      );
      expect(retryLog).toBeDefined();
      const [, fields] = retryLog as [string, Record<string, unknown>];
      expect(fields.stale).toBe(true);
      expect(fields.delayMs).toBe(15_000);

      vi.useRealTimers();
      await adapter.teardown();
    });

    it('dedupes a duplicate deliver call within TTL', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, { kind: 'text', content: { text: 'same body' } });
      await adapter.deliver('+15555550123', null, { kind: 'text', content: { text: 'same body' } });

      expect(getRpcCallsForMethod('send')).toHaveLength(1);

      await adapter.teardown();
    });

    it('does not dedupe different text bodies', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, { kind: 'text', content: { text: 'hi' } });
      await adapter.deliver('+15555550123', null, { kind: 'text', content: { text: 'hello' } });

      expect(getRpcCallsForMethod('send')).toHaveLength(2);

      await adapter.teardown();
    });

    it('does not dedupe same caption with different attached files', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: { text: 'caption' },
        files: [{ filename: 'a.txt', data: Buffer.from('AAA') }],
      });
      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: { text: 'caption' },
        files: [{ filename: 'b.txt', data: Buffer.from('BBBB') }],
      });

      // Each deliver combines caption + attachment into a single send.
      // Two deliveries should produce 2 sends total when dedupe is
      // fingerprint-aware (same caption, different files → distinct keys).
      expect(getRpcCallsForMethod('send')).toHaveLength(2);

      await adapter.teardown();
    });
  });

  // --- Connection drop ---

  describe('connection drop', () => {
    it('flips isConnected to false when the socket closes', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      expect(adapter.isConnected()).toBe(true);

      // Simulate the daemon dropping the TCP connection.
      tcpRef.fakeSocket.destroy();
      await new Promise((r) => setTimeout(r, 20));

      expect(adapter.isConnected()).toBe(false);

      await adapter.teardown();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator for DMs', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.setTyping!('+15555550123', null);

      expect(getRpcCallsForMethod('sendTyping')).toHaveLength(1);

      await adapter.teardown();
    });

    it('skips typing for groups', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.setTyping!('group:abc123', null);

      expect(getRpcCallsForMethod('sendTyping')).toHaveLength(0);

      await adapter.teardown();
    });
  });

  // --- Adapter properties ---

  describe('adapter properties', () => {
    it('has channelType "signal"', () => {
      const adapter = createAdapter();
      expect(adapter.channelType).toBe('signal');
    });

    it('does not support threads', () => {
      const adapter = createAdapter();
      expect(adapter.supportsThreads).toBe(false);
    });
  });
});
