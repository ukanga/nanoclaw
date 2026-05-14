import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetForTests,
  drainDeliveryFailures,
  formatDeliveryFailureBlock,
  recordDeliveryFailure,
} from './delivery-failures.js';

const JID = 'signal:group:test';

afterEach(() => {
  _resetForTests();
});

describe('delivery-failures', () => {
  it('drain returns empty when nothing recorded', () => {
    expect(drainDeliveryFailures(JID)).toEqual([]);
  });

  it('records and drains once per jid', () => {
    recordDeliveryFailure(JID, 'reply A', new Error('boom'));
    const first = drainDeliveryFailures(JID);
    expect(first).toHaveLength(1);
    expect(first[0].cleaned).toBe('reply A');
    expect(first[0].reason).toBe('boom');
    expect(first[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Drain is destructive — a second drain returns nothing
    expect(drainDeliveryFailures(JID)).toEqual([]);
  });

  it('accumulates multiple failures and preserves order', () => {
    recordDeliveryFailure(JID, 'first', new Error('one'));
    recordDeliveryFailure(JID, 'second', new Error('two'));
    const drained = drainDeliveryFailures(JID);
    expect(drained.map((f) => f.cleaned)).toEqual(['first', 'second']);
  });

  it('separates failures by jid', () => {
    recordDeliveryFailure(JID, 'for-A', new Error('a'));
    recordDeliveryFailure('signal:group:other', 'for-B', new Error('b'));
    expect(drainDeliveryFailures(JID).map((f) => f.cleaned)).toEqual(['for-A']);
    expect(
      drainDeliveryFailures('signal:group:other').map((f) => f.cleaned),
    ).toEqual(['for-B']);
  });

  it('coerces non-Error reasons to string', () => {
    recordDeliveryFailure(JID, 'reply', 'string-error');
    expect(drainDeliveryFailures(JID)[0].reason).toBe('string-error');
  });

  it('formats an empty failure list as empty string', () => {
    expect(formatDeliveryFailureBlock([])).toBe('');
  });

  it('formats failures into a delivery-failures block with marker preserved', () => {
    recordDeliveryFailure(
      JID,
      'The file is good\n[[attach:/workspace/group/outbox/pl-2026.xlsx]]',
      new Error(
        'Failed to send message: javax.net.ssl.SSLException: bad_record_mac',
      ),
    );
    const block = formatDeliveryFailureBlock(drainDeliveryFailures(JID));

    expect(block).toContain('<delivery-failures');
    expect(block).toContain('did NOT reach the user');
    expect(block).toContain('<failed-reply');
    expect(block).toContain('bad_record_mac');
    expect(block).toContain('[[attach:/workspace/group/outbox/pl-2026.xlsx]]');
    expect(block).toContain('</failed-reply>');
    expect(block).toContain('</delivery-failures>');
    expect(block.endsWith('\n')).toBe(true);
  });

  it('escapes XML metacharacters in timestamp/reason attributes', () => {
    recordDeliveryFailure(JID, 'body', new Error('boom <crash> & "quote"'));
    const block = formatDeliveryFailureBlock(drainDeliveryFailures(JID));
    // Inside attribute values these should be encoded
    expect(block).toContain(
      'reason="boom &lt;crash&gt; &amp; &quot;quote&quot;"',
    );
    // Body content is not escaped — it's the agent's own output replayed verbatim
    expect(block).toContain('body');
  });
});
