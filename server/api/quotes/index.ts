import { defineEventHandler, readBody } from 'h3';
import { Quote } from '../../db/index.js';

function generateReference(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'UQ-';
  for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

export default defineEventHandler(async (event) => {
  if (event.method !== 'POST') {
    event.node.res.statusCode = 405;
    return { success: false, error: 'Method not allowed' };
  }

  try {
    const body = await readBody(event);
    const { customerName, email, phone, items } = body || {};
    if (!customerName?.trim() || !email?.trim() || !phone?.trim() || !Array.isArray(items) || items.length === 0) {
      event.node.res.statusCode = 400;
      return { success: false, error: 'Missing required fields' };
    }

    const quote = await Quote.create({
      reference: generateReference(),
      customerName: customerName.trim(),
      company: body.company || '',
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      notes: body.notes || '',
      items: items.map((item: any) => ({
        id: String(item.id), name: String(item.name), kind: item.kind === 'service' ? 'service' : 'product', qty: Math.max(Number(item.qty) || 1, 1),
      })),
      status: 'received',
    });

    return { success: true, reference: quote.reference };
  } catch (error) {
    console.error('Error in quote API:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to create quote' };
  }
});
