import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maybeAutoRotateSession } from './session-rotation.js';
import { RegisteredGroup } from './types.js';

const FOLDER = 'team-rot';
const SESSION_ID = 'sess-rot';

const group: RegisteredGroup = {
  name: 'Team Rotation',
  folder: FOLDER,
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

function writeSession(projectRoot: string, bytes: number): string {
  const dir = path.join(
    projectRoot,
    'data',
    'sessions',
    FOLDER,
    '.claude',
    'projects',
    '-workspace-group',
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, 'x'.repeat(bytes));
  return file;
}

describe('maybeAutoRotateSession', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'session-rotation-test-'),
    );
    process.env.NANOCLAW_PROJECT_ROOT = projectRoot;
    delete process.env.AUTO_COMPACT_THRESHOLD_BYTES;
  });

  afterEach(() => {
    delete process.env.NANOCLAW_PROJECT_ROOT;
    delete process.env.AUTO_COMPACT_THRESHOLD_BYTES;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('no-ops when sessionId is undefined', async () => {
    const runAgent = vi.fn(async () => 'success' as const);
    const setTyping = vi.fn(async () => {});

    await maybeAutoRotateSession({
      group,
      chatJid: 'jid',
      sessionId: undefined,
      setTyping,
      runAgent,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(setTyping).not.toHaveBeenCalled();
  });

  it('no-ops when the session file does not exist', async () => {
    const runAgent = vi.fn(async () => 'success' as const);
    const setTyping = vi.fn(async () => {});

    await maybeAutoRotateSession({
      group,
      chatJid: 'jid',
      sessionId: SESSION_ID, // file not written
      setTyping,
      runAgent,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(setTyping).not.toHaveBeenCalled();
  });

  it('no-ops when live bytes are below the threshold', async () => {
    writeSession(projectRoot, 10_000); // well below 500 KB default
    const runAgent = vi.fn(async () => 'success' as const);
    const setTyping = vi.fn(async () => {});

    await maybeAutoRotateSession({
      group,
      chatJid: 'jid',
      sessionId: SESSION_ID,
      setTyping,
      runAgent,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(setTyping).not.toHaveBeenCalled();
  });

  it('rotates when over threshold: typing on, continuation prompt, then /compact, typing off', async () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '1000';
    writeSession(projectRoot, 5000);

    const events: string[] = [];
    const runAgent = vi.fn(async (prompt: string) => {
      events.push(`runAgent:${prompt.startsWith('/compact') ? 'compact' : 'continuation'}`);
      return 'success' as const;
    });
    const setTyping = vi.fn(async (on: boolean) => {
      events.push(`typing:${on}`);
    });

    await maybeAutoRotateSession({
      group,
      chatJid: 'jid',
      sessionId: SESSION_ID,
      setTyping,
      runAgent,
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    // First call: continuation prompt (wrapped in <internal>)
    const firstPrompt = runAgent.mock.calls[0][0] as string;
    expect(firstPrompt).toContain('<internal>');
    expect(firstPrompt).toContain('Continuation notes');
    expect(firstPrompt).toContain('What was just accomplished');
    expect(firstPrompt).toContain('What was about to happen next');
    // Second call: literal /compact (exact-match path in agent-runner)
    expect(runAgent.mock.calls[1][0]).toBe('/compact');

    // Typing toggles around the rotation
    expect(events[0]).toBe('typing:true');
    expect(events[events.length - 1]).toBe('typing:false');
    expect(events).toEqual([
      'typing:true',
      'runAgent:continuation',
      'runAgent:compact',
      'typing:false',
    ]);
  });

  it('skips /compact if the continuation-notes step fails (avoids compacting without a handoff note)', async () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '1000';
    writeSession(projectRoot, 5000);

    const runAgent = vi
      .fn<(prompt: string) => Promise<'success' | 'error'>>()
      .mockResolvedValueOnce('error');
    const setTyping = vi.fn(async () => {});

    await maybeAutoRotateSession({
      group,
      chatJid: 'jid',
      sessionId: SESSION_ID,
      setTyping,
      runAgent,
    });

    expect(runAgent).toHaveBeenCalledTimes(1); // only the continuation prompt
    expect(setTyping).toHaveBeenCalledWith(true);
    expect(setTyping).toHaveBeenCalledWith(false); // still cleared via finally
  });

  it('clears typing in finally even when runAgent throws', async () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '1000';
    writeSession(projectRoot, 5000);

    const runAgent = vi.fn(async () => {
      throw new Error('boom');
    });
    const setTyping = vi.fn(async () => {});

    // Should not propagate the error to callers — rotation is best-effort.
    await expect(
      maybeAutoRotateSession({
        group,
        chatJid: 'jid',
        sessionId: SESSION_ID,
        setTyping,
        runAgent: runAgent as unknown as (
          p: string,
        ) => Promise<'success' | 'error'>,
      }),
    ).resolves.toBeUndefined();

    expect(setTyping).toHaveBeenCalledWith(true);
    expect(setTyping).toHaveBeenCalledWith(false);
  });

  it('passes a no-op onOutput so any stray agent text is not forwarded to the user', async () => {
    process.env.AUTO_COMPACT_THRESHOLD_BYTES = '1000';
    writeSession(projectRoot, 5000);

    type RunAgent = (
      prompt: string,
      onOutput?: (o: unknown) => Promise<void>,
    ) => Promise<'success' | 'error'>;

    const runAgent = vi.fn<RunAgent>(async () => 'success' as const);
    const setTyping = vi.fn(async () => {});

    await maybeAutoRotateSession({
      group,
      chatJid: 'jid',
      sessionId: SESSION_ID,
      setTyping,
      runAgent: runAgent as unknown as (
        prompt: string,
        onOutput?: (o: import('./container-runner.js').ContainerOutput) => Promise<void>,
      ) => Promise<'success' | 'error'>,
    });

    for (const call of runAgent.mock.calls) {
      const onOutput = call[1];
      expect(typeof onOutput).toBe('function');
      // Calling the callback with any output must not throw or reach the user
      // (the orchestrator's normal callback would send to the channel; this
      // one swallows).
      await expect(
        onOutput!({
          status: 'success',
          result: 'some agent text',
          newSessionId: undefined,
        }),
      ).resolves.toBeUndefined();
    }
  });
});
