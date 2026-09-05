import { defineEventHandler, getQuery } from 'h3';
import { Quote } from '../../db/index.js';

const projection = {
  _id: 1, reference: 1, customerName: 1, email: 1, phone: 1, status: 1,
  items: 1, replyMessage: 1, repliedAt: 1, createdAt: 1,
};

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    const reference = typeof query.ref === 'string' ? query.ref.trim().toUpperCase() : '';
    const email = typeof query.email === 'string' ? query.email.trim().toLowerCase() : '';

    if (!reference || !email) {
      event.node.res.statusCode = 400;
      return { success: false, error: 'Reference and email are required', quote: null };
    }

    const quote = await Quote.findOne({ reference, email }, projection).lean().exec();
    if (!quote) {
      event.node.res.statusCode = 404;
      return { success: false, error: 'Quote not found', quote: null };
    }

    return {
      success: true,
      quote: {
        id: quote._id.toString(),
        reference: quote.reference,
        customerName: quote.customerName,
        email: quote.email,
        phone: quote.phone,
        status: quote.status,
        items: (quote.items || []).map((item: any) => ({ id: item.id, name: item.name, qty: item.qty })),
        replyMessage: quote.replyMessage || null,
        repliedAt: quote.repliedAt ? quote.repliedAt.toISOString() : null,
        createdAt: quote.createdAt.toISOString(),
      },
    };
  } catch (error) {
    console.error('Error tracking quote:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to track quote', quote: null };
  }
});
