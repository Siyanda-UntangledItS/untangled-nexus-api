import type { H3Event } from 'h3';

/** Lightweight request timing. It never blocks the request and only logs slow calls. */
export function performanceMiddleware(event: H3Event): void {
  const started = process.hrtime.bigint();
  event.node.res.once('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const threshold = Number(process.env.SLOW_REQUEST_MS || 500);
    if (elapsedMs >= threshold) {
      console.warn(`🐢 Slow API request ${event.method} ${event.path} ${elapsedMs.toFixed(1)}ms`);
    }
  });
}
