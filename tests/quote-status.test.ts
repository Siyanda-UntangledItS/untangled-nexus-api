/**
 * Quote status machine unit tests.
 * Run: npx tsx --test tests/quote-status.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionQuoteStatus,
  QUOTE_STATUSES,
  QUOTE_STATUS_TRANSITIONS,
} from '../server/types/quote.types.js';

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

  it('rejects closed → anything', () => {
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
      assert.ok(
        s in QUOTE_STATUS_TRANSITIONS,
        `missing transitions for ${s}`
      );
    }
  });
});
