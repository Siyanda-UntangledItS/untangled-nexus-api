/**
 * Shared security middleware for h3:
 * - CORS allow-list
 * - Security headers
 * - Simple in-memory rate limiting (no external deps)
 */
import type { H3Event } from 'h3';
import { config } from '../config/index.js';

// ---------- Rate limiting (in-memory, per-process) ----------
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function clientKey(event: H3Event, prefix: string): string {
  const ip =
    (event.node.req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    event.node.req.socket?.remoteAddress ||
    'unknown';
  return `${prefix}:${ip}`;
}

/**
 * Returns true if the request is allowed, false if rate-limited.
 */
export function checkRateLimit(
  event: H3Event,
  prefix: string,
  max: number,
  windowMs: number
): boolean {
  const key = clientKey(event, prefix);
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  // Opportunistic cleanup of expired buckets
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      if (now > b.resetAt) buckets.delete(k);
    }
  }

  return bucket.count <= max;
}

// ---------- CORS + security headers ----------
export async function securityMiddleware(event: H3Event): Promise<void> {
  const res = event.node.res;
  const origin = (event.node.req.headers.origin as string) || '';

  // CORS – explicit allow-list only
  const allowed =
    config.corsOrigins.includes(origin) ||
    (config.isDev && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')));

  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  // Never set * when credentials are used

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers; CSP preferred
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  // CSP – start conservative; tighten further in production once nonces/hashes known
  if (config.isProd) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }

  if (event.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
}

/**
 * Rate-limit helper for sensitive endpoints.
 * Call at the start of a handler; returns a response body if limited.
 */
export function rateLimitOrNull(
  event: H3Event,
  kind: 'auth' | 'write' | 'track' | 'default'
): { statusCode: number; body: object } | null {
  let max = config.rateLimitMax;
  let prefix = 'default';

  switch (kind) {
    case 'auth':
      max = config.rateLimitAuthMax;
      prefix = 'auth';
      break;
    case 'write':
      max = Math.min(config.rateLimitMax, 60);
      prefix = 'write';
      break;
    case 'track':
      max = Math.min(config.rateLimitMax, 120);
      prefix = 'track';
      break;
    default:
      break;
  }

  const ok = checkRateLimit(event, prefix, max, config.rateLimitWindowMs);
  if (ok) return null;

  return {
    statusCode: 429,
    body: {
      success: false,
      error: 'Too many requests. Please try again later.',
      code: 'RATE_LIMITED',
    },
  };
}
