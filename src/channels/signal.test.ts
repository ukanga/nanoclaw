import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: true,
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process (for daemon spawn — we won't manage daemon in tests)
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

// --- Fetch mock ---

const fetchRef = vi.hoisted(() => ({
  rpcResponses: new Map<string, unknown>(),
  sseController: null as ReadableStreamDefaultController<Uint8Array> | null,
}));

// Mock global fetch
const mockFetch = vi.fn(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Health check
    if (url.includes('/api/v1/check')) {
      return new Response('OK', { status: 200 });
    }

    // RPC endpoint
    if (url.includes('/api/v1/rpc')) {
      const body = JSON.parse(init?.body as string);
      const result = fetchRef.rpcResponses.get(body.method) ?? { ok: true };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // SSE endpoint — return a stream we can push events into
    if (url.includes('/api/v1/events')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          fetchRef.sseController = controller;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
);

vi.stubGlobal('fetch', mockFetch);

import { SignalChannel, type SignalChannelOpts } from './signal.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+15555550123': {
        name: 'Test DM',
        folder: 'test-dm',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal:group:abc123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createChannel(opts?: Partial<SignalChannelOpts>): SignalChannel {
  // manageDaemon=false so we don't try to spawn signal-cli
  return new SignalChannel(
    'signal-cli',
    '+15551234567',
    '127.0.0.1',
    7583,
    createTestOpts(opts),
    false, // don't manage daemon — we mock fetch instead
  );
}

function pushSseEvent(envelope: Record<string, unknown>) {
  if (!fetchRef.sseController) throw new Error('SSE stream not started');
  const data = JSON.stringify({ envelope });
  const event = `data: ${data}\n\n`;
  fetchRef.sseController.enqueue(new TextEncoder().encode(event));
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchRef.rpcResponses.clear();
    fetchRef.sseController = null;
    fetchRef.rpcResponses.set('send', { timestamp: 1234567890 });
    fetchRef.rpcResponses.set('sendTyping', {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Close any open SSE streams
    try {
      fetchRef.sseController?.close();
    } catch {
      // already closed
    }
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects when daemon is reachable', async () => {
      const channel = createChannel();
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      // Should have called /api/v1/check
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/check'),
        expect.anything(),
      );

      await channel.disconnect();
    });

    it('isConnected() returns false before connect', () => {
      const channel = createChannel();
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const channel = createChannel();
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('throws if daemon is unreachable', async () => {
      mockFetch.mockImplementationOnce(async () => {
        throw new Error('Connection refused');
      });

      const channel = createChannel();
      await expect(channel.connect()).rejects.toThrow(/not reachable/);
    });
  });

  // --- Inbound message handling ---

  describe('inbound message handling', () => {
    it('delivers DM for registered chat', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Hello from Signal',
        },
      });

      // Allow async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+15555550123',
        expect.any(String),
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15555550123',
        expect.objectContaining({
          chat_jid: 'signal:+15555550123',
          sender: '+15555550123',
          sender_name: 'Alice',
          content: 'Hello from Signal',
          is_from_me: false,
        }),
      );

      await channel.disconnect();
    });

    it('delivers group message with group JID', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550999',
        sourceName: 'Bob',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Group hello',
          groupInfo: { groupId: 'abc123', groupName: 'Family' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:group:abc123',
        expect.any(String),
        'Family',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:group:abc123',
        expect.objectContaining({
          chat_jid: 'signal:group:abc123',
          sender: '+15555550999',
          content: 'Group hello',
        }),
      );

      await channel.disconnect();
    });

    it('skips sync messages (own outbound)', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
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
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('processes Note to Self sync messages as inbound', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'signal:+15551234567': {
            name: 'Note to Self',
            folder: 'note-to-self',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
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
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          sender: '+15551234567',
          sender_name: 'Me',
          content: 'Hello Bee',
          is_from_me: true,
        }),
      );

      await channel.disconnect();
    });

    it('skips empty messages', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: '   ' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('skips messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+19999999999',
        sourceName: 'Unknown',
        dataMessage: { timestamp: 1700000000000, message: 'Unknown sender' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('skips echoed outbound messages', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      // Send a message first (adds to echo cache)
      await channel.sendMessage('signal:+15555550123', 'Echo test');

      // Simulate same text coming back
      pushSseEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: 'Echo test' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('prepends trigger when assistant name mentioned in groups', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550999',
        sourceName: 'Bob',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Hey Andy what time is it?',
          groupInfo: { groupId: 'abc123', groupName: 'Family' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:group:abc123',
        expect.objectContaining({
          content: '@Andy Hey Andy what time is it?',
        }),
      );

      await channel.disconnect();
    });

    it('does not prepend trigger if already matching', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550999',
        sourceName: 'Bob',
        dataMessage: {
          timestamp: 1700000000000,
          message: '@Andy what time is it?',
          groupInfo: { groupId: 'abc123', groupName: 'Family' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:group:abc123',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );

      await channel.disconnect();
    });
  });

  // --- Attachment-only messages ---

  describe('attachment-only messages', () => {
    it('skips messages with attachments but no text', async () => {
      const testOpts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        testOpts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          attachments: [
            { id: 'att123abc', contentType: 'image/jpeg', size: 50000 },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(testOpts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends DM via HTTP RPC', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('signal:+15555550123', 'Hello');

      const rpcCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/v1/rpc'),
      );
      expect(rpcCalls.length).toBeGreaterThan(0);

      const lastRpcBody = JSON.parse(
        rpcCalls[rpcCalls.length - 1]![1]!.body as string,
      );
      expect(lastRpcBody.method).toBe('send');
      expect(lastRpcBody.params).toEqual(
        expect.objectContaining({
          recipient: ['+15555550123'],
          message: 'Hello',
          account: '+15551234567',
        }),
      );

      await channel.disconnect();
    });

    it('sends group message via groupId', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('signal:group:abc123', 'Group msg');

      const rpcCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/v1/rpc'),
      );

      const lastRpcBody = JSON.parse(
        rpcCalls[rpcCalls.length - 1]![1]!.body as string,
      );
      expect(lastRpcBody.method).toBe('send');
      expect(lastRpcBody.params).toEqual(
        expect.objectContaining({
          groupId: 'abc123',
          message: 'Group msg',
        }),
      );

      await channel.disconnect();
    });

    it('chunks long messages', async () => {
      const channel = createChannel();
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('signal:+15555550123', longText);

      const rpcCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/v1/rpc'),
      );
      const sendCalls = rpcCalls.filter((c) => {
        const body = JSON.parse(c[1]!.body as string);
        return body.method === 'send';
      });
      expect(sendCalls.length).toBeGreaterThan(1);

      await channel.disconnect();
    });

    it('does nothing when not connected', async () => {
      const channel = createChannel();
      // Don't connect
      await channel.sendMessage('signal:+15555550123', 'No connection');
      // No RPC calls should have been made
      const rpcCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/v1/rpc'),
      );
      expect(rpcCalls).toHaveLength(0);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns signal: JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('signal:+15555550123')).toBe(true);
    });

    it('owns signal:group: JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('signal:group:abc123')).toBe(true);
    });

    it('does not own telegram JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own imessage JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('imsg:+15555550123')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator for DMs', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.setTyping('signal:+15555550123', true);

      const rpcCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/v1/rpc'),
      );
      const typingCalls = rpcCalls.filter((c) => {
        const body = JSON.parse(c[1]!.body as string);
        return body.method === 'sendTyping';
      });
      expect(typingCalls).toHaveLength(1);

      await channel.disconnect();
    });

    it('skips typing for groups', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.setTyping('signal:group:abc123', true);

      const rpcCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/v1/rpc'),
      );
      const typingCalls = rpcCalls.filter((c) => {
        const body = JSON.parse(c[1]!.body as string);
        return body.method === 'sendTyping';
      });
      expect(typingCalls).toHaveLength(0);

      await channel.disconnect();
    });

    it('does nothing when not connected', async () => {
      const channel = createChannel();
      await channel.setTyping('signal:+15555550123', true);
      // No error, no fetch calls
    });
  });

  // --- Quote context ---

  describe('quote context', () => {
    it('prepends quoted message context to inbound messages', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'I disagree',
          quote: {
            id: 1699999999000,
            authorNumber: '+15555550888',
            text: 'Pineapple belongs on pizza',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15555550123',
        expect.objectContaining({
          content: '> +15555550888: Pineapple belongs on pizza\n\nI disagree',
        }),
      );

      await channel.disconnect();
    });

    it('delivers message without quote prefix when no quote present', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Just a regular message',
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15555550123',
        expect.objectContaining({
          content: 'Just a regular message',
        }),
      );

      await channel.disconnect();
    });

    it('skips quote prefix when quote has no text', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Replying to an image',
          quote: {
            id: 1699999999000,
            authorNumber: '+15555550888',
            text: '',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15555550123',
        expect.objectContaining({
          content: 'Replying to an image',
        }),
      );

      await channel.disconnect();
    });
  });

  // --- Text styles ---

  describe('text styles', () => {
    it('sends bold text with textStyle parameter in string format', async () => {
      const channel = createChannel();
      await channel.connect();
      mockFetch.mockClear();

      await channel.sendMessage('signal:+15555550123', 'Hello **world**');

      const rpcCall = mockFetch.mock.calls.find((c) =>
        (c[0] as string).includes('/api/v1/rpc'),
      );
      expect(rpcCall).toBeDefined();
      const body = JSON.parse(rpcCall![1]?.body as string);
      expect(body.params.message).toBe('Hello world');
      // signal-cli JSON-RPC uses "textStyle" (singular) with "start:length:STYLE" strings
      expect(body.params.textStyle).toEqual(['6:5:BOLD']);

      await channel.disconnect();
    });

    it('sends inline code with MONOSPACE style', async () => {
      const channel = createChannel();
      await channel.connect();
      mockFetch.mockClear();

      await channel.sendMessage('signal:+15555550123', 'Run `npm test` now');

      const rpcCall = mockFetch.mock.calls.find((c) =>
        (c[0] as string).includes('/api/v1/rpc'),
      );
      const body = JSON.parse(rpcCall![1]?.body as string);
      expect(body.params.message).toBe('Run npm test now');
      expect(body.params.textStyle).toEqual(['4:8:MONOSPACE']);

      await channel.disconnect();
    });

    it('sends plain text without textStyle parameter', async () => {
      const channel = createChannel();
      await channel.connect();
      mockFetch.mockClear();

      await channel.sendMessage('signal:+15555550123', 'No formatting here');

      const rpcCall = mockFetch.mock.calls.find((c) =>
        (c[0] as string).includes('/api/v1/rpc'),
      );
      const body = JSON.parse(rpcCall![1]?.body as string);
      expect(body.params.message).toBe('No formatting here');
      expect(body.params.textStyle).toBeUndefined();

      await channel.disconnect();
    });

    it('handles multiple styles in one message', async () => {
      const channel = createChannel();
      await channel.connect();
      mockFetch.mockClear();

      await channel.sendMessage('signal:+15555550123', '**Bold** and _italic_');

      const rpcCall = mockFetch.mock.calls.find((c) =>
        (c[0] as string).includes('/api/v1/rpc'),
      );
      const body = JSON.parse(rpcCall![1]?.body as string);
      expect(body.params.message).toBe('Bold and italic');
      expect(body.params.textStyle).toEqual(
        expect.arrayContaining(['0:4:BOLD', '9:6:ITALIC']),
      );

      await channel.disconnect();
    });

    it('uses "textStyle" (singular) parameter name with string format', async () => {
      const channel = createChannel();
      await channel.connect();
      mockFetch.mockClear();

      await channel.sendMessage('signal:+15555550123', 'Hello **world**');

      const rpcCall = mockFetch.mock.calls.find((c) =>
        (c[0] as string).includes('/api/v1/rpc'),
      );
      const body = JSON.parse(rpcCall![1]?.body as string);

      // signal-cli JSON-RPC uses "textStyle" (singular), not "textStyles"
      expect(body.params).toHaveProperty('textStyle');
      expect(body.params).not.toHaveProperty('textStyles');
      // Format is "start:length:STYLE" strings, not JSON objects
      expect(body.params.textStyle[0]).toMatch(/^\d+:\d+:\w+$/);

      await channel.disconnect();
    });

    it('falls back to plain text (no styles) when textStyle is rejected', async () => {
      const channel = createChannel();
      await channel.connect();
      mockFetch.mockClear();

      // First RPC call (with textStyle) fails, second (fallback) succeeds
      let callCount = 0;
      mockFetch.mockImplementation(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;

          if (url.includes('/api/v1/rpc')) {
            callCount++;
            const body = JSON.parse(init?.body as string);
            if (body.method === 'send' && callCount === 1) {
              // Reject the first send (with textStyles)
              return new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  error: { message: 'Unknown parameter: textStyle' },
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              );
            }
            // Second send (fallback) succeeds
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { ok: true },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }

          if (url.includes('/api/v1/check')) {
            return new Response('OK', { status: 200 });
          }

          return new Response('Not Found', { status: 404 });
        },
      );

      await channel.sendMessage('signal:+15555550123', 'Hello **world**');

      // Should have made 2 RPC calls: styled (failed) + fallback
      const rpcCalls = mockFetch.mock.calls.filter((c) =>
        (c[0] as string).includes('/api/v1/rpc'),
      );
      expect(rpcCalls.length).toBe(2);

      // Fallback should send stripped plain text (not raw markup)
      const fallbackBody = JSON.parse(rpcCalls[1][1]?.body as string);
      expect(fallbackBody.params.message).toBe('Hello world');
      expect(fallbackBody.params.textStyle).toBeUndefined();

      // Restore default mock
      mockFetch.mockImplementation(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;
          if (url.includes('/api/v1/check'))
            return new Response('OK', { status: 200 });
          if (url.includes('/api/v1/rpc')) {
            const body = JSON.parse(init?.body as string);
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { ok: true },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url.includes('/api/v1/events')) {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                fetchRef.sseController = controller;
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      );

      await channel.disconnect();
    });

    it('does not retry on timeout errors (prevents duplicate messages)', async () => {
      const channel = createChannel();
      await channel.connect();
      mockFetch.mockClear();

      let callCount = 0;
      mockFetch.mockImplementation(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;

          if (url.includes('/api/v1/rpc')) {
            callCount++;
            if (callCount === 1) {
              // Simulate timeout (AbortError) — message was likely already delivered
              throw new DOMException(
                'This operation was aborted',
                'AbortError',
              );
            }
            // Should never reach here
            const body = JSON.parse(init?.body as string);
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { ok: true },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }

          if (url.includes('/api/v1/check')) {
            return new Response('OK', { status: 200 });
          }

          return new Response('Not Found', { status: 404 });
        },
      );

      try {
        // sendMessage propagates the failure so the caller can mark the
        // message undelivered; the key assertion is that there is no retry.
        await expect(
          channel.sendMessage('signal:+15555550123', 'Hello **world**'),
        ).rejects.toThrow(/aborted/i);

        // Should have made only 1 RPC call — no retry on timeout.
        const rpcCalls = mockFetch.mock.calls.filter((c) =>
          (c[0] as string).includes('/api/v1/rpc'),
        );
        expect(rpcCalls.length).toBe(1);
      } finally {
        // Restore the default mock even if the assertion above throws,
        // otherwise subsequent tests' SSE setup breaks.
        mockFetch.mockImplementation(
          async (input: string | URL | Request, init?: RequestInit) => {
            const url =
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (input as Request).url;
            if (url.includes('/api/v1/check'))
              return new Response('OK', { status: 200 });
            if (url.includes('/api/v1/rpc')) {
              const body = JSON.parse(init?.body as string);
              return new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: { ok: true },
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              );
            }
            if (url.includes('/api/v1/events')) {
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  fetchRef.sseController = controller;
                },
              });
              return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
              });
            }
            return new Response('Not Found', { status: 404 });
          },
        );

        await channel.disconnect();
      }
    });
  });

  // --- Inbound attachments ---

  describe('inbound attachments', () => {
    let testRoot: string;
    let cacheDir: string;
    let groupsDir: string;
    let inboxDir: string;
    const groupJid = 'signal:group:abc123';
    const groupFolder = 'test-group';

    function stashCacheFile(
      id: string,
      contents: string | Buffer = 'fake bytes',
      ext = '',
    ): void {
      fs.writeFileSync(path.join(cacheDir, `${id}${ext}`), contents);
    }

    function lastOnMessageCall(opts: SignalChannelOpts) {
      const calls = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1] as [string, Record<string, unknown>];
    }

    beforeEach(() => {
      testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'signal-attachments-test-'),
      );
      cacheDir = path.join(testRoot, 'cache');
      groupsDir = path.join(testRoot, 'groups');
      inboxDir = path.join(groupsDir, groupFolder, 'inbox');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.mkdirSync(groupsDir, { recursive: true });
      process.env.SIGNAL_ATTACHMENTS_DIR = cacheDir;
      process.env.NANOCLAW_GROUPS_DIR = groupsDir;
    });

    afterEach(() => {
      delete process.env.SIGNAL_ATTACHMENTS_DIR;
      delete process.env.NANOCLAW_GROUPS_DIR;
      fs.rmSync(testRoot, { recursive: true, force: true });
    });

    it('materializes a single image attachment with caption', async () => {
      stashCacheFile('att1', 'png-bytes');
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Look at this',
          groupInfo: { groupId: 'abc123', groupName: 'Test Group' },
          attachments: [
            {
              id: 'att1',
              contentType: 'image/png',
              filename: 'budget.png',
              size: 9,
            },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      const [jid, msg] = lastOnMessageCall(opts);
      expect(jid).toBe(groupJid);
      expect(msg.content).toContain('Look at this');
      expect(msg.content).toContain(
        '[Attachment: /workspace/group/inbox/1700000000000-budget.png, image/png, 9 B]',
      );
      expect(msg.attachments).toEqual([
        {
          path: '/workspace/group/inbox/1700000000000-budget.png',
          contentType: 'image/png',
          filename: 'budget.png',
          size: 9,
        },
      ]);
      expect(
        fs.existsSync(path.join(inboxDir, '1700000000000-budget.png')),
      ).toBe(true);

      await channel.disconnect();
    });

    it('handles multi-file attachment message with no caption', async () => {
      stashCacheFile('att-a', 'A'.repeat(2048));
      stashCacheFile('att-b', 'B'.repeat(500));
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000001000,
          message: '',
          groupInfo: { groupId: 'abc123', groupName: 'Test Group' },
          attachments: [
            {
              id: 'att-a',
              contentType: 'application/pdf',
              filename: 'report.pdf',
              size: 2048,
            },
            {
              id: 'att-b',
              contentType: 'image/jpeg',
              filename: 'chart.jpg',
              size: 500,
            },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      const [, msg] = lastOnMessageCall(opts);
      expect(msg.content).toBe(
        [
          '[Attachment: /workspace/group/inbox/1700000001000-report.pdf, application/pdf, 2 KB]',
          '[Attachment: /workspace/group/inbox/1700000001000-chart.jpg, image/jpeg, 500 B]',
        ].join('\n'),
      );
      expect((msg.attachments as unknown[]).length).toBe(2);
      expect(
        fs.existsSync(path.join(inboxDir, '1700000001000-report.pdf')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(inboxDir, '1700000001000-chart.jpg')),
      ).toBe(true);

      await channel.disconnect();
    });

    it('skips oversize attachments and drops the message when nothing remains', async () => {
      stashCacheFile('big', 'x'.repeat(10));
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000002000,
          message: '',
          groupInfo: { groupId: 'abc123', groupName: 'Test Group' },
          attachments: [
            {
              id: 'big',
              contentType: 'video/mp4',
              filename: 'huge.mp4',
              size: 30 * 1024 * 1024,
            },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(inboxDir, '1700000002000-huge.mp4'))).toBe(
        false,
      );

      await channel.disconnect();
    });

    it('sanitizes malicious filenames', async () => {
      stashCacheFile('att-evil', 'data');
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000003000,
          message: 'evil',
          groupInfo: { groupId: 'abc123', groupName: 'Test Group' },
          attachments: [
            {
              id: 'att-evil',
              contentType: 'application/pdf',
              filename: '../../../etc/passwd',
              size: 4,
            },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      const [, msg] = lastOnMessageCall(opts);
      // basename + sanitization: "../../../etc/passwd" → basename "passwd" → "passwd"
      expect(msg.attachments).toEqual([
        expect.objectContaining({
          path: '/workspace/group/inbox/1700000003000-passwd',
        }),
      ]);
      expect(fs.existsSync(path.join(inboxDir, '1700000003000-passwd'))).toBe(
        true,
      );
      // No file written outside the expected inbox directory
      const inboxEntries = fs.readdirSync(inboxDir);
      expect(inboxEntries).toEqual(['1700000003000-passwd']);

      await channel.disconnect();
    });

    it('warns and skips when source file is missing from cache', async () => {
      // Note: no stashCacheFile call — the source is missing.
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000004000,
          message: 'where is it',
          groupInfo: { groupId: 'abc123', groupName: 'Test Group' },
          attachments: [
            {
              id: 'ghost',
              contentType: 'image/png',
              filename: 'ghost.png',
              size: 100,
            },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Message still delivered (it has caption text), but with no attachment
      const [, msg] = lastOnMessageCall(opts);
      expect(msg.content).toBe('where is it');
      expect(msg.attachments).toBeUndefined();
      expect(
        fs.existsSync(path.join(inboxDir, '1700000004000-ghost.png')),
      ).toBe(false);

      await channel.disconnect();
    });

    it('does not double-append the extension when the cache id already has one', async () => {
      // signal-cli sometimes stores attachments under "<id>.<ext>" and
      // returns that as the id; the filename field is absent. We must not
      // tack a second contentType-derived extension on top.
      stashCacheFile('captured.png', 'png-bytes');
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000006000,
          message: 'shot',
          groupInfo: { groupId: 'abc123', groupName: 'Test Group' },
          attachments: [
            { id: 'captured.png', contentType: 'image/png', size: 9 },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      const [, msg] = lastOnMessageCall(opts);
      expect(msg.attachments).toEqual([
        expect.objectContaining({
          path: '/workspace/group/inbox/1700000006000-attachment-captured.png',
        }),
      ]);
      expect(
        fs.existsSync(
          path.join(inboxDir, '1700000006000-attachment-captured.png'),
        ),
      ).toBe(true);

      await channel.disconnect();
    });

    it('combines quote prefix with attachment markers', async () => {
      stashCacheFile('att-q', 'qbytes');
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'signal-cli',
        '+15551234567',
        '127.0.0.1',
        7583,
        opts,
        false,
      );
      await channel.connect();

      pushSseEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000005000,
          message: 'See attached',
          groupInfo: { groupId: 'abc123', groupName: 'Test Group' },
          quote: {
            id: 1699999999000,
            authorNumber: '+15555550888',
            text: 'Can you send the file?',
          },
          attachments: [
            {
              id: 'att-q',
              contentType: 'application/pdf',
              filename: 'doc.pdf',
              size: 6,
            },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      const [, msg] = lastOnMessageCall(opts);
      expect(msg.content).toBe(
        '> +15555550888: Can you send the file?\n\nSee attached\n[Attachment: /workspace/group/inbox/1700000005000-doc.pdf, application/pdf, 6 B]',
      );

      await channel.disconnect();
    });
  });

  // --- Outbound attachments ---

  describe('outbound attachments', () => {
    let attachDir: string;

    function makeFile(name: string, contents = 'data'): string {
      const p = path.join(attachDir, name);
      fs.writeFileSync(p, contents);
      return p;
    }

    function lastSendPayload(): Record<string, unknown> {
      const rpcCalls = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes('/api/v1/rpc'),
      );
      const body = JSON.parse(
        (rpcCalls[rpcCalls.length - 1][1] as RequestInit).body as string,
      );
      return body.params as Record<string, unknown>;
    }

    function allSendPayloads(): Record<string, unknown>[] {
      return mockFetch.mock.calls
        .filter((c) => String(c[0]).includes('/api/v1/rpc'))
        .map((c) => {
          const body = JSON.parse((c[1] as RequestInit).body as string);
          return body.params as Record<string, unknown>;
        });
    }

    beforeEach(() => {
      attachDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'signal-outbound-test-'),
      );
    });

    afterEach(() => {
      fs.rmSync(attachDir, { recursive: true, force: true });
    });

    it('forwards a single attachment to signal-cli send params', async () => {
      const filePath = makeFile('report.pdf');
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('signal:+15555550123', 'Here it is', [
        filePath,
      ]);

      const params = lastSendPayload();
      expect(params.message).toBe('Here it is');
      expect(params.attachments).toEqual([filePath]);

      await channel.disconnect();
    });

    it('forwards multiple attachments in one send call', async () => {
      const a = makeFile('a.pdf');
      const b = makeFile('b.xlsx');
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('signal:+15555550123', 'Two files', [a, b]);

      const params = lastSendPayload();
      expect(params.attachments).toEqual([a, b]);

      await channel.disconnect();
    });

    it('allows attachment-only messages (empty caption)', async () => {
      const filePath = makeFile('silent.pdf');
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('signal:+15555550123', '', [filePath]);

      const params = lastSendPayload();
      expect(params.message).toBe('');
      expect(params.attachments).toEqual([filePath]);

      await channel.disconnect();
    });

    it('throws on non-existent attachment without sending', async () => {
      const channel = createChannel();
      await channel.connect();

      const beforeCount = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes('/api/v1/rpc'),
      ).length;

      await expect(
        channel.sendMessage('signal:+15555550123', 'hi', [
          path.join(attachDir, 'does-not-exist.pdf'),
        ]),
      ).rejects.toThrow(/attachment file not found/i);

      const afterCount = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes('/api/v1/rpc'),
      ).length;
      expect(afterCount).toBe(beforeCount);

      await channel.disconnect();
    });

    it('throws on relative attachment path without sending', async () => {
      const channel = createChannel();
      await channel.connect();

      const beforeCount = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes('/api/v1/rpc'),
      ).length;

      await expect(
        channel.sendMessage('signal:+15555550123', 'hi', ['relative.pdf']),
      ).rejects.toThrow(/must be absolute/i);

      const afterCount = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes('/api/v1/rpc'),
      ).length;
      expect(afterCount).toBe(beforeCount);

      await channel.disconnect();
    });

    it('attaches files only to the first chunk when text is split', async () => {
      const filePath = makeFile('once.pdf');
      const channel = createChannel();
      await channel.connect();

      // 4001 chars to force a 2-chunk split (MAX_CHUNK = 4000)
      const longText = 'A'.repeat(4001);
      await channel.sendMessage('signal:+15555550123', longText, [filePath]);

      const sends = allSendPayloads();
      // signal-cli was called at least twice (one per chunk) — guard against
      // styled-send retries by filtering to non-retry payloads only.
      const sendsForChunks = sends.filter((p) => 'recipient' in p);
      expect(sendsForChunks.length).toBeGreaterThanOrEqual(2);
      expect(sendsForChunks[0].attachments).toEqual([filePath]);
      expect(sendsForChunks[1].attachments).toBeUndefined();

      await channel.disconnect();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = createChannel();
      expect(channel.name).toBe('signal');
    });
  });
});
