/**
 * Central configuration – environment only.
 * No secrets are hardcoded.
 */
import dotenv from 'dotenv';
dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const nodeEnv = optional('NODE_ENV', 'development');
const isDev = nodeEnv === 'development';

/** Comma-separated list of allowed CORS origins */
const corsOriginsRaw = optional(
  'CORS_ORIGINS',
  isDev ? 'http://localhost:5173,http://localhost:5174' : ''
);

const corsOrigins = corsOriginsRaw
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const config = {
  port: parseInt(optional('PORT', '5001'), 10),
  desktopPort: parseInt(optional('DESKTOP_PORT', '10000'), 10),
  nodeEnv,
  isDev,
  isProd: nodeEnv === 'production',

  /** MongoDB URI – required outside pure local fallback usage */
  mongoUri: process.env.MONGODB_URI || (isDev ? 'mongodb://localhost:27017/untangled_its' : ''),

  frontendUrl: optional('FRONTEND_URL', 'http://localhost:5173'),
  corsOrigins,

  /** JWT / session secret – required in production */
  jwtSecret: process.env.JWT_SECRET || (isDev ? 'dev-only-change-me' : ''),

  /** Rate limiting */
  rateLimitWindowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '900000'), 10), // 15 min
  rateLimitMax: parseInt(optional('RATE_LIMIT_MAX', '200'), 10),
  rateLimitAuthMax: parseInt(optional('RATE_LIMIT_AUTH_MAX', '20'), 10), // stricter for login
} as const;

export function assertProductionConfig(): void {
  if (!config.isProd) return;
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required in production');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET (min 32 chars) is required in production');
  }
  if (config.corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be set in production');
  }
}
