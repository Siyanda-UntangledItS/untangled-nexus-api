# Untangled Nexus API – Performance Optimisation

This release keeps the existing H3 + Mongoose API architecture and focuses on reducing database work, response payloads, sequential waits, and startup/query overhead.

## What changed

### Database
- Reused a single Mongoose connection promise so concurrent startup/request paths do not create duplicate connections.
- Added configurable MongoDB connection pooling.
- Reduced connection/selection timeouts so failed database connections fail faster.
- Added indexes for high-frequency public and desktop/admin lookups.

### Public APIs
- Product/service/catalog lists now use bounded pagination (`limit` + `skip`).
- Product filtering and text search now work together.
- List endpoints use `.lean()` and focused projections where practical.
- Search runs product and service queries concurrently with `Promise.all`.
- Order and quote tracking use normalized, index-friendly exact lookups.
- Order status updates use an atomic `findOneAndUpdate` instead of read → mutate → save.
- Request validation returns appropriate 400/404/405/500 status codes.

### Desktop/admin API
- Existing desktop API behaviour is preserved.
- Both server variants use the same faster MongoDB pool settings.
- High-frequency native MongoDB collections receive indexes at startup.

### Diagnostics
- Added `server/middleware/performance.ts` to report requests above `SLOW_REQUEST_MS` without blocking responses.
- Added `npm run benchmark` for repeatable local latency measurements.

## Important compatibility note

The two existing server entry points remain available so current website/desktop integrations are not broken during the optimisation phase:

- `server/index-working-v2.ts`
- `server/index-desktop.ts`

The long-term target is still one production API entry point. That consolidation should be done after integration tests confirm all routes currently used by the website and desktop app.

## Suggested environment settings

```env
MONGODB_MAX_POOL_SIZE=20
MONGODB_MIN_POOL_SIZE=5
MONGODB_MAX_IDLE_TIME_MS=30000
MONGODB_SERVER_SELECTION_TIMEOUT_MS=5000
MONGODB_SOCKET_TIMEOUT_MS=10000
MONGODB_CONNECT_TIMEOUT_MS=5000
SLOW_REQUEST_MS=500
```

Tune pool sizes from measured production traffic rather than simply increasing them.

## Benchmark

Start the API, then run:

```bash
npm run benchmark
```

Custom API:

```bash
API_URL=http://localhost:5001 npm run benchmark
```

Custom routes:

```bash
BENCHMARK_PATHS=/api/health,/api/products?limit=24 npm run benchmark
```

The benchmark reports average, p95, minimum and maximum request latency.
