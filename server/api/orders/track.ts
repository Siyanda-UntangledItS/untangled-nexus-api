import { defineEventHandler, getQuery } from 'h3';
import { Order } from '../../db/index.js';

const projection = {
  reference: 1, customerName: 1, email: 1, phone: 1, address: 1, notes: 1,
  status: 1, items: 1, total: 1, trackingNumber: 1, carrier: 1,
  estimatedDelivery: 1, createdAt: 1, updatedAt: 1,
};

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    const ref = typeof query.ref === 'string' ? query.ref.trim().toUpperCase() : '';
    const email = typeof query.email === 'string' ? query.email.trim().toLowerCase() : '';

    if (!ref || !email) {
      event.node.res.statusCode = 400;
      return { success: false, error: 'Reference and email are required', order: null };
    }

    const order = await Order.findOne({ reference: ref, email }, projection).lean().exec();
    if (!order) {
      event.node.res.statusCode = 404;
      return { success: false, error: 'Order not found. Check your reference and email.', order: null };
    }

    return {
      success: true,
      order: {
        reference: order.reference,
        customerName: order.customerName,
        email: order.email,
        phone: order.phone,
        address: order.address,
        notes: order.notes || '',
        status: order.status,
        items: (order.items || []).map((item: any) => ({ id: item.id, name: item.name, qty: item.qty, price: item.price })),
        total: order.total,
        trackingNumber: order.trackingNumber || null,
        carrier: order.carrier || null,
        estimatedDelivery: order.estimatedDelivery || null,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt || order.createdAt,
      },
    };
  } catch (error) {
    console.error('Error tracking order:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to track order', order: null };
  }
});
