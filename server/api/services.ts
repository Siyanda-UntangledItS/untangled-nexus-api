import { defineEventHandler, getQuery } from 'h3';
import { Service } from '../db/index.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const group = typeof query.group === 'string' ? query.group.trim() : '';
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = Math.max(Number(query.skip) || 0, 0);
    const filter: Record<string, unknown> = {};
    if (group) filter.group = group;

    let cursor = Service.find(
      search ? { ...filter, $text: { $search: search } } : filter,
      search ? { score: { $meta: 'textScore' } } : undefined
    );
    if (search) cursor = cursor.sort({ score: { $meta: 'textScore' } });

    const services = await cursor.skip(skip).limit(limit).lean().exec();
    return { success: true, data: services, pagination: { limit, skip, count: services.length } };
  } catch (error) {
    console.error('Error fetching services:', error);
    event.node.res.statusCode = 500;
    return { success: false, error: 'Failed to fetch services' };
  }
});
