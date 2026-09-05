/**
 * Quote business service.
 * Used by route handlers; keeps Mongo + in-memory fallback behaviour
 * compatible with the existing public API.
 */
import type { Model } from 'mongoose';
import type { CreateQuoteInput, QuoteStatus } from '../types/quote.types.js';
import { canTransitionQuoteStatus } from '../types/quote.types.js';

export interface QuoteServiceDeps {
  QuoteModel: Model<any>;
  isMongoConnected: () => boolean;
  inMemoryQuotes: any[];
  generateReference: (prefix?: string) => string;
  extractPaymentAmount: (replyMessage: string) => number | null;
}

export function createQuoteService(deps: QuoteServiceDeps) {
  const {
    QuoteModel,
    isMongoConnected,
    inMemoryQuotes,
    generateReference,
    extractPaymentAmount,
  } = deps;

  async function createQuote(input: CreateQuoteInput) {
    const { customerName, company, email, phone, notes, items } = input;

    if (!customerName?.trim() || !email?.trim() || !phone?.trim()) {
      return { ok: false as const, status: 400, error: 'Missing required fields' };
    }
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false as const, status: 400, error: 'At least one item is required' };
    }

    const reference = generateReference('UQ');
    const quoteData = {
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
      status: 'received' as QuoteStatus,
      paymentRequired: false,
      paymentAmount: 0,
      paymentStatus: 'pending',
      feedback: { submitted: false },
    };

    let savedQuote: any;

    if (isMongoConnected()) {
      try {
        const quote = new QuoteModel(quoteData);
        savedQuote = await quote.save();
      } catch (dbError) {
        console.error('❌ Failed to save quote to MongoDB:', dbError);
        savedQuote = { ...quoteData, _id: `mem_${Date.now()}` };
        inMemoryQuotes.push(savedQuote);
      }
    } else {
      savedQuote = { ...quoteData, _id: `mem_${Date.now()}` };
      inMemoryQuotes.push(savedQuote);
    }

    return { ok: true as const, reference: savedQuote.reference as string };
  }

  async function trackQuote(ref: string, email: string) {
    if (!ref?.trim() || !email?.trim()) {
      return {
        ok: false as const,
        status: 400,
        error: 'Reference and email are required',
        quote: null,
      };
    }

    const cleanRef = ref.trim().toUpperCase();
    const cleanEmail = email.trim().toLowerCase();
    let quote: any = null;

    if (isMongoConnected()) {
      quote = await QuoteModel.findOne({ reference: cleanRef, email: cleanEmail }).lean().exec();
    }
    if (!quote) {
      quote = inMemoryQuotes.find(
        (q) => q.reference === cleanRef && q.email === cleanEmail
      );
    }
    if (!quote) {
      return {
        ok: false as const,
        status: 404,
        error: 'Quote not found. Check your reference and email.',
        quote: null,
      };
    }

    let paymentRequired = quote.paymentRequired || false;
    let paymentAmount = quote.paymentAmount || 0;
    if (!paymentRequired && quote.replyMessage) {
      const extracted = extractPaymentAmount(quote.replyMessage);
      if (extracted) {
        paymentRequired = true;
        paymentAmount = extracted;
      }
    }

    return {
      ok: true as const,
      quote: {
        id: quote._id?.toString() || `mem_${Date.now()}`,
        reference: quote.reference,
        customerName: quote.customerName,
        email: quote.email,
        phone: quote.phone,
        status: quote.status,
        items: (quote.items || []).map((item: any) => ({
          id: item.id,
          name: item.name,
          qty: item.qty,
          image: item.image || null,
        })),
        replyMessage: quote.replyMessage || null,
        repliedAt: quote.repliedAt || null,
        createdAt: quote.createdAt,
        paymentRequired,
        paymentAmount,
        paymentStatus: quote.paymentStatus || 'pending',
        feedback: quote.feedback || null,
      },
    };
  }

  async function listQuotes(limit = 50) {
    let quotes: any[] = [];
    if (isMongoConnected()) {
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      quotes = await QuoteModel.find({}, {
        reference: 1, customerName: 1, company: 1, email: 1, phone: 1, notes: 1,
        status: 1, createdAt: 1, items: 1, paymentRequired: 1, paymentAmount: 1,
        paymentStatus: 1, feedback: 1, replyMessage: 1, assigned_to: 1, assigned_by: 1,
      }).sort({ createdAt: -1 }).limit(safeLimit).lean().exec();
    } else {
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      quotes = [...inMemoryQuotes].slice(0, safeLimit);
    }
    return {
      ok: true as const,
      count: quotes.length,
      quotes: quotes.map((q) => ({
        reference: q.reference,
        customerName: q.customerName,
        company: q.company || '',
        email: q.email,
        phone: q.phone || '',
        notes: q.notes || '',
        status: q.status,
        createdAt: q.createdAt,
        items: q.items,
        paymentRequired: q.paymentRequired || false,
        paymentAmount: q.paymentAmount || 0,
        paymentStatus: q.paymentStatus || 'pending',
        feedback: q.feedback || { submitted: false },
        replyMessage: q.replyMessage || null,
        assigned_to: q.assigned_to || null,
        assigned_by: q.assigned_by || null,
      })),
    };
  }

  async function updateQuoteStatus(reference: string, status: QuoteStatus) {
    if (!isMongoConnected()) {
      return { ok: false as const, status: 503, error: 'Database not connected' };
    }
    const cleanReference = reference.trim().toUpperCase();
    const current = await QuoteModel.findOne({ reference: cleanReference }, { reference: 1, status: 1 }).lean().exec();
    if (!current) {
      return { ok: false as const, status: 404, error: 'Quote not found' };
    }
    const from = current.status as QuoteStatus;
    if (!canTransitionQuoteStatus(from, status)) {
      return {
        ok: false as const,
        status: 400,
        error: `Invalid status transition from '${from}' to '${status}'`,
      };
    }

    // Atomic update prevents a second request from overwriting a newer status.
    const updated = await QuoteModel.findOneAndUpdate(
      { reference: cleanReference, status: from },
      { $set: { status, updatedAt: new Date() } },
      { new: true, projection: { reference: 1, status: 1 } }
    ).lean().exec();

    if (!updated) {
      return { ok: false as const, status: 409, error: 'Quote was changed by another request. Please retry.' };
    }

    return {
      ok: true as const,
      quote: { reference: updated.reference, status: updated.status },
    };
  }

  return {
    createQuote,
    trackQuote,
    listQuotes,
    updateQuoteStatus,
  };
}

export type QuoteService = ReturnType<typeof createQuoteService>;
