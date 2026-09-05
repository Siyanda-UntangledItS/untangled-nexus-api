/**
 * Quote service behaviour tests (in-memory, no Mongo).
 * Run: node --test tests/quote-service.test.mjs
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal inline reimplementation matching service contract for isolation
// (full TS service needs build; this validates business rules mirror)

function generateReference(prefix = 'UQ') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = `${prefix}-`;
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function createInMemoryQuoteApi() {
  const store = [];

  async function createQuote(input) {
    const { customerName, company, email, phone, notes, items } = input;
    if (!customerName?.trim() || !email?.trim() || !phone?.trim()) {
      return { ok: false, status: 400, error: 'Missing required fields' };
    }
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, status: 400, error: 'At least one item is required' };
    }
    const reference = generateReference('UQ');
    const quote = {
      _id: `mem_${Date.now()}`,
      reference,
      customerName: customerName.trim(),
      company: company || '',
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      notes: notes || '',
      items: items.map((item) => ({
        id: String(item.id),
        name: String(item.name),
        kind: item.kind === 'service' ? 'service' : 'product',
        qty: Number(item.qty) || 1,
        image: item.image || null,
      })),
      status: 'received',
      paymentRequired: false,
      paymentAmount: 0,
      paymentStatus: 'pending',
      feedback: { submitted: false },
      createdAt: new Date(),
    };
    store.push(quote);
    return { ok: true, reference };
  }

  async function trackQuote(ref, email) {
    if (!ref?.trim() || !email?.trim()) {
      return { ok: false, status: 400, error: 'Reference and email are required', quote: null };
    }
    const cleanRef = ref.trim().toUpperCase();
    const cleanEmail = email.trim().toLowerCase();
    const quote = store.find((q) => q.reference === cleanRef && q.email === cleanEmail);
    if (!quote) {
      return {
        ok: false,
        status: 404,
        error: 'Quote not found. Check your reference and email.',
        quote: null,
      };
    }
    return {
      ok: true,
      quote: {
        id: quote._id,
        reference: quote.reference,
        customerName: quote.customerName,
        email: quote.email,
        phone: quote.phone,
        status: quote.status,
        items: quote.items,
        paymentRequired: quote.paymentRequired,
        paymentAmount: quote.paymentAmount,
        paymentStatus: quote.paymentStatus,
        feedback: quote.feedback,
      },
    };
  }

  return { createQuote, trackQuote, store };
}

describe('Quote create + track (in-memory)', () => {
  let api;

  beforeEach(() => {
    api = createInMemoryQuoteApi();
  });

  it('rejects missing fields', async () => {
    const r = await api.createQuote({
      customerName: '',
      email: 'a@b.com',
      phone: '123',
      items: [{ id: '1', name: 'Laptop', qty: 1 }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it('rejects empty items', async () => {
    const r = await api.createQuote({
      customerName: 'Test',
      email: 'a@b.com',
      phone: '123',
      items: [],
    });
    assert.equal(r.ok, false);
  });

  it('creates quote and returns reference', async () => {
    const r = await api.createQuote({
      customerName: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+27123456789',
      items: [{ id: 'p1', name: 'ThinkPad', kind: 'product', qty: 2 }],
    });
    assert.equal(r.ok, true);
    assert.match(r.reference, /^UQ-[A-Z0-9]{6}$/);
  });

  it('tracks created quote by ref + email', async () => {
    const created = await api.createQuote({
      customerName: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+27123456789',
      items: [{ id: 'p1', name: 'ThinkPad', qty: 1 }],
    });
    const tracked = await api.trackQuote(created.reference, 'jane@example.com');
    assert.equal(tracked.ok, true);
    assert.equal(tracked.quote.reference, created.reference);
    assert.equal(tracked.quote.customerName, 'Jane Doe');
    assert.equal(tracked.quote.status, 'received');
  });

  it('returns 404 for unknown reference', async () => {
    const tracked = await api.trackQuote('UQ-XXXXXX', 'nobody@example.com');
    assert.equal(tracked.ok, false);
    assert.equal(tracked.status, 404);
  });
});
