import { defineEventHandler, readBody, getQuery } from 'h3';
import { Order } from '../../db/index.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const listProjection = {
  reference: 1, customerName: 1, company: 1, email: 1, phone: 1, address: 1,
  notes: 1, status: 1, total: 1, createdAt: 1, updatedAt: 1, items: 1,
  trackingNumber: 1, carrier: 1, assigned_to: 1, assigned_by: 1,
};

export default defineEventHandler(async (event) => {
  if (event.method === 'GET') {
    try {
      const query = getQuery(event);
      const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const skip = Math.max(Number(query.skip) || 0, 0);
      const orders = await Order.find({}, listProjection)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec();

      return {
        success: true,
        count: orders.length,
        orders,
        pagination: { limit, skip, count: orders.length },
      };
    } catch (error) {
      console.error('Error fetching orders:', error);
      event.node.res.statusCode = 500;
      return { success: false, error: 'Failed to fetch orders' };
    }
  }

  if (event.method !== 'POST') {
    event.node.res.statusCode = 405;
    return { success: false, error: `Method ${event.method} not allowed for /api/orders` };
  }

  try {
    const body = await readBody(event);
    const { customerName, email, phone, address, items, total } = body || {};

    if (!customerName?.trim() || !email?.trim() || !phone?.trim() || !address?.trim() || !Array.isArray(items) || items.length === 0) {
      event.node.res.statusCode = 400;
      return { success: false, error: 'Missing required fields' };
    }

    const order = await Order.create({
      customerName: customerName.trim(),
      company: body.company || '',
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      address: address.trim(),
      notes: body.notes || '',
      items: items.map((item: any) => ({
        id: String(item.id), name: String(item.name), qty: Math.max(Number(item.qty) || 1, 1), price: Math.max(Number(item.price) || 0, 0),
      })),
      total: Math.max(Number(total) || 0, 0),
      status: 'pending',
    });

    return { success: true, orderId: order._id, orderReference: order.reference };
  } catch (error) {
    console.error('Error creating order:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to process order' };
  }
});
