/**
 * Tests for recording delivery failures back into the agent's inbound
 * stream (kind='delivery-failure', trigger=0).
 *
 * The replay path is the v2 version of v1's in-memory delivery-failures
 * Map: instead of holding the failure in process memory keyed by chat
 * id, we persist a messages_in row per session that the container's
 * formatter renders as a <delivery-failures> block on the next turn.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery-failures' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-failures';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { inboundDbPath, resolveSession } from './session-manager.js';
import { recordDeliveryFailureForAgent } from './delivery-failures.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'signal',
    platform_id: 'signal:group:x',
    name: 'Test Group',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

interface MessagesInRow {
  id: string;
  kind: string;
  trigger: number;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  status: string;
}

function readMessagesIn(agentGroupId: string, sessionId: string): MessagesInRow[] {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  const rows = db.prepare('SELECT * FROM messages_in ORDER BY seq ASC').all() as MessagesInRow[];
  db.close();
  return rows;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('recordDeliveryFailureForAgent', () => {
  it('writes a delivery-failure row with trigger=0 into the session inbound.db', () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    recordDeliveryFailureForAgent(
      session,
      {
        id: 'out-1',
        content: JSON.stringify({ text: 'reply A' }),
        channel_type: 'signal',
        platform_id: 'signal:group:x',
        thread_id: null,
      },
      new Error('signal-cli TLS error'),
    );

    const rows = readMessagesIn('ag-1', session.id);
    const failure = rows.find((r) => r.kind === 'delivery-failure');
    expect(failure).toBeDefined();
    expect(failure!.trigger).toBe(0);
    expect(failure!.status).toBe('pending');
    expect(failure!.platform_id).toBe('signal:group:x');
    expect(failure!.channel_type).toBe('signal');

    const content = JSON.parse(failure!.content);
    expect(content.originalMessageOutId).toBe('out-1');
    expect(content.reason).toBe('signal-cli TLS error');
    expect(content.payload).toEqual({ text: 'reply A' });
  });

  it('coerces non-Error reasons to string', () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    recordDeliveryFailureForAgent(
      session,
      {
        id: 'out-2',
        content: JSON.stringify({ text: 'reply' }),
        channel_type: 'signal',
        platform_id: 'signal:group:x',
        thread_id: null,
      },
      'plain-string-error',
    );

    const rows = readMessagesIn('ag-1', session.id);
    const failure = rows.find((r) => r.kind === 'delivery-failure');
    const content = JSON.parse(failure!.content);
    expect(content.reason).toBe('plain-string-error');
  });

  it('preserves non-JSON content as the raw payload string', () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    recordDeliveryFailureForAgent(
      session,
      {
        id: 'out-3',
        content: 'not-json-here',
        channel_type: 'signal',
        platform_id: 'signal:group:x',
        thread_id: null,
      },
      new Error('boom'),
    );

    const rows = readMessagesIn('ag-1', session.id);
    const failure = rows.find((r) => r.kind === 'delivery-failure');
    const content = JSON.parse(failure!.content);
    expect(content.payload).toBe('not-json-here');
  });

  it('accumulates multiple failures as separate rows', () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    recordDeliveryFailureForAgent(
      session,
      {
        id: 'out-A',
        content: JSON.stringify({ text: 'A' }),
        channel_type: 'signal',
        platform_id: 'signal:group:x',
        thread_id: null,
      },
      new Error('one'),
    );
    recordDeliveryFailureForAgent(
      session,
      {
        id: 'out-B',
        content: JSON.stringify({ text: 'B' }),
        channel_type: 'signal',
        platform_id: 'signal:group:x',
        thread_id: null,
      },
      new Error('two'),
    );

    const failures = readMessagesIn('ag-1', session.id).filter((r) => r.kind === 'delivery-failure');
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => JSON.parse(f.content).originalMessageOutId)).toEqual(['out-A', 'out-B']);
    // trigger=0 on every row so they ride along the next user-triggered turn
    expect(failures.every((f) => f.trigger === 0)).toBe(true);
  });

  it('captures files for outbound replies that were attachments', () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    recordDeliveryFailureForAgent(
      session,
      {
        id: 'out-files',
        content: JSON.stringify({ text: 'here you go', files: ['pl-2026.xlsx'] }),
        channel_type: 'signal',
        platform_id: 'signal:group:x',
        thread_id: null,
      },
      new Error('javax.net.ssl.SSLException: bad_record_mac'),
    );

    const failure = readMessagesIn('ag-1', session.id).find((r) => r.kind === 'delivery-failure')!;
    const payload = JSON.parse(failure.content).payload;
    expect(payload.text).toBe('here you go');
    expect(payload.files).toEqual(['pl-2026.xlsx']);
  });
});
