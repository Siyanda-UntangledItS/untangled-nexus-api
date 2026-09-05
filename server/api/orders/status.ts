import { defineEventHandler, readBody } from 'h3';
import { Order } from '../../db/index.js';

const allowedStatuses = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);

export default defineEventHandler(async (event) => {
  if (!['PATCH', 'POST'].includes(event.method)) {
    event.node.res.statusCode = 405;
    return { success: false, message: 'Method not allowed' };
  }

  try {
    const body = await readBody(event);
    const reference = typeof body?.reference === 'string' ? body.reference.trim().toUpperCase() : '';
    const status = typeof body?.status === 'string' ? body.status.trim().toLowerCase() : '';

    if (!reference || !status) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Reference and status are required' };
    }
    if (!allowedStatuses.has(status)) {
      event.node.res.statusCode = 400;
      return { success: false, message: 'Invalid order status' };
    }

    const update: Record<string, unknown> = { status, updatedAt: new Date() };
    if (body.trackingNumber !== undefined) update.trackingNumber = body.trackingNumber || null;
    if (body.carrier !== undefined) update.carrier = body.carrier || null;
    if (body.estimatedDelivery !== undefined) {
      const date = new Date(body.estimatedDelivery);
      if (Number.isNaN(date.getTime())) {
        event.node.res.statusCode = 400;
        return { success: false, message: 'Invalid estimated delivery date' };
      }
      update.estimatedDelivery = date;
    }

    const order = await Order.findOneAndUpdate(
      { reference },
      { $set: update },
      { new: true, projection: { reference: 1, status: 1, trackingNumber: 1, carrier: 1, estimatedDelivery: 1 } }
    ).lean().exec();

    if (!order) {
      event.node.res.statusCode = 404;
      return { success: false, message: 'Order not found' };
    }

    return {
      success: true,
      message: 'Order status updated',
      order: {
        reference: order.reference,
        status: order.status,
        trackingNumber: order.trackingNumber || null,
        carrier: order.carrier || null,
        estimatedDelivery: order.estimatedDelivery || null,
      },
    };
  } catch (error) {
    console.error('Error updating order status:', error);
    event.node.res.statusCode = 500;
    return { success: false, message: 'Failed to update order status' };
  }
});
