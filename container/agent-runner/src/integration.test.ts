import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { transcriptPath } from './session-rotation.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  content: object,
  opts?: { platformId?: string; channelType?: string; threadId?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'What is the meaning of life?' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  describe('proactive /compact rotation', () => {
    let tmpProjectsDir: string;
    const originalProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
    const originalThreshold = process.env.AUTO_COMPACT_THRESHOLD_BYTES;

    beforeEach(() => {
      tmpProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-int-'));
      process.env.CLAUDE_PROJECTS_DIR = tmpProjectsDir;
      process.env.AUTO_COMPACT_THRESHOLD_BYTES = '500';
    });

    afterEach(() => {
      fs.rmSync(tmpProjectsDir, { recursive: true, force: true });
      if (originalProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
      else process.env.CLAUDE_PROJECTS_DIR = originalProjectsDir;
      if (originalThreshold === undefined) delete process.env.AUTO_COMPACT_THRESHOLD_BYTES;
      else process.env.AUTO_COMPACT_THRESHOLD_BYTES = originalThreshold;
    });

    it('pushes /compact when transcript exceeds threshold and swallows the boundary result', async () => {
      insertMessage('m1', { sender: 'Alice', text: 'Hello' }, { platformId: 'chan-1', channelType: 'discord' });

      const promptsReceived: string[] = [];
      const provider = new MockProvider({}, (prompt) => {
        promptsReceived.push(prompt);
        // After init has fired, the continuation is persisted by the poll-loop.
        // Write a transcript over the threshold so shouldRotateSession trips
        // on the post-result check.
        const continuation = getContinuation('mock');
        if (continuation) {
          const tp = transcriptPath(continuation, '/workspace/agent');
          fs.mkdirSync(path.dirname(tp), { recursive: true });
          fs.writeFileSync(tp, 'x'.repeat(2000));
        }
        return prompt === '/compact' ? 'Context compacted (100 tokens).' : '<message to="discord-test">hi</message>';
      });

      const controller = new AbortController();
      const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000, '/workspace/agent');

      // Wait until rotation has fired (responseFactory invoked with `/compact`).
      await waitFor(() => promptsReceived.includes('/compact'), 2500);
      // Give the loop a beat to consume the boundary result event.
      await sleep(100);
      controller.abort();

      expect(promptsReceived).toContain('/compact');

      const out = getUndeliveredMessages();
      // Only one outbound — the agent's real reply. The post-/compact
      // "Context compacted" result must be swallowed, not dispatched.
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0].content).text).toBe('hi');

      await loopPromise.catch(() => {});
    });

    it('does not push /compact when transcript is under the threshold', async () => {
      insertMessage('m2', { sender: 'Bob', text: 'Quick' }, { platformId: 'chan-1', channelType: 'discord' });

      const promptsReceived: string[] = [];
      const provider = new MockProvider({}, (prompt) => {
        promptsReceived.push(prompt);
        const continuation = getContinuation('mock');
        if (continuation) {
          const tp = transcriptPath(continuation, '/workspace/agent');
          fs.mkdirSync(path.dirname(tp), { recursive: true });
          // Small transcript — well under the 500-byte threshold.
          fs.writeFileSync(tp, 'x'.repeat(50));
        }
        return '<message to="discord-test">ok</message>';
      });

      const controller = new AbortController();
      const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2500, '/workspace/agent');

      await waitFor(() => getUndeliveredMessages().length > 0, 2000);
      await sleep(200);
      controller.abort();

      expect(promptsReceived).not.toContain('/compact');
      expect(getUndeliveredMessages()).toHaveLength(1);

      await loopPromise.catch(() => {});
    });
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });
});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(
  provider: MockProvider,
  signal: AbortSignal,
  timeoutMs: number,
  cwd: string = '/tmp',
): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
