import { defineEventHandler, getQuery } from 'h3';
import { Product } from '../db/index.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    const segment = typeof query.segment === 'string' ? query.segment.trim() : '';
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = Math.max(Number(query.skip) || 0, 0);

    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (segment) filter.segment = segment;

    let cursor = Product.find(
      search ? { ...filter, $text: { $search: search } } : filter,
      search ? { score: { $meta: 'textScore' } } : undefined
    );

    if (search) cursor = cursor.sort({ score: { $meta: 'textScore' } });

    const products = await cursor
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    return { success: true, data: products, pagination: { limit, skip, count: products.length } };
  } catch (error) {
    console.error('Error fetching products:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to fetch products' };
  }
});
