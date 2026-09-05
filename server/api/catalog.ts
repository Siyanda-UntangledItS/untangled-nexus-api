import { defineEventHandler, getQuery } from 'h3';
import { CatalogItem } from '../db/index.js';
import type { ICatalogItem } from '../models/CatalogItem.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = Math.max(Number(query.skip) || 0, 0);
    const filter: { category?: ICatalogItem['category'] } = category
      ? { category: category as ICatalogItem['category'] }
      : {};

    const items = await CatalogItem.find(filter)
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    return { success: true, data: items, pagination: { limit, skip, count: items.length } };
  } catch (error) {
    console.error('Error fetching catalog:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to fetch catalog' };
  }
});
