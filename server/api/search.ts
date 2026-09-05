import { defineEventHandler, getQuery } from 'h3';
import { Product, Service } from '../db/index.js';

const LIMIT = 20;

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    const searchTerm = typeof query.q === 'string' ? query.q.trim() : '';

    if (!searchTerm) return { success: true, data: { products: [], services: [] } };

    // Product and service searches are independent; don't make the second query
    // wait for the first one.
    const [products, services] = await Promise.all([
      Product.find(
        { $text: { $search: searchTerm } },
        { score: { $meta: 'textScore' } }
      ).sort({ score: { $meta: 'textScore' } }).limit(LIMIT).lean().exec(),
      Service.find(
        { $text: { $search: searchTerm } },
        { score: { $meta: 'textScore' } }
      ).sort({ score: { $meta: 'textScore' } }).limit(LIMIT).lean().exec(),
    ]);

    return { success: true, data: { products, services } };
  } catch (error) {
    console.error('Error searching:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Search failed' };
  }
});
