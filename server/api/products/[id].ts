import { defineEventHandler } from 'h3';
import { Product } from '../../db/index.js';

export default defineEventHandler(async (event) => {
  try {
    const id = event.context.params?.id?.trim();
    if (!id) {
      event.node.res.statusCode = 400;
      return { success: false, error: 'Product ID is required' };
    }

    const product = await Product.findOne({ id }).lean().exec();
    if (!product) {
      event.node.res.statusCode = 404;
      return { success: false, error: 'Product not found' };
    }

    return { success: true, data: product };
  } catch (error) {
    console.error('Error fetching product:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to fetch product' };
  }
});
