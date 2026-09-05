/**
 * Quote status machine unit tests (plain ESM, no build step).
 * Run: node --test tests/quote-status.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const QUOTE_STATUSES = [
  'received',
  'in_review',
  'quoted',
  'closed',
  'pending',
  'waiting_feedback',
  'in_touch',
  'approved',
  'payment',
];

const QUOTE_STATUS_TRANSITIONS = {
  received: ['in_review', 'in_touch', 'quoted', 'closed'],
  in_review: ['quoted', 'in_touch', 'waiting_feedback', 'closed'],
  quoted: ['approved', 'payment', 'waiting_feedback', 'closed', 'in_touch'],
  pending: ['in_review', 'quoted', 'closed'],
  waiting_feedback: ['approved', 'quoted', 'closed', 'in_touch'],
  in_touch: ['quoted', 'approved', 'payment', 'closed', 'in_review'],
  approved: ['payment', 'closed'],
  payment: ['closed', 'approved'],
  closed: [],
};

function canTransitionQuoteStatus(from, to) {
  if (from === to) return true;
  return QUOTE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

describe('Quote status machine', () => {
  it('defines all expected statuses', () => {
    assert.ok(QUOTE_STATUSES.includes('received'));
    assert.ok(QUOTE_STATUSES.includes('quoted'));
    assert.ok(QUOTE_STATUSES.includes('closed'));
    assert.ok(QUOTE_STATUSES.includes('payment'));
  });

  it('allows received → in_review', () => {
    assert.equal(canTransitionQuoteStatus('received', 'in_review'), true);
  });

  it('allows same status (no-op)', () => {
    assert.equal(canTransitionQuoteStatus('quoted', 'quoted'), true);
  });

  it('rejects closed → anything else', () => {
    for (const s of QUOTE_STATUSES) {
      if (s === 'closed') continue;
      assert.equal(
        canTransitionQuoteStatus('closed', s),
        false,
        `closed → ${s} should be false`
      );
    }
  });

  it('rejects received → payment (skip path)', () => {
    assert.equal(canTransitionQuoteStatus('received', 'payment'), false);
  });

  it('every status has a transition entry', () => {
    for (const s of QUOTE_STATUSES) {
      assert.ok(s in QUOTE_STATUS_TRANSITIONS, `missing transitions for ${s}`);
    }
  });
});
