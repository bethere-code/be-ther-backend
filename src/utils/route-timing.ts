import type { FastifyBaseLogger } from 'fastify';

/**
 * Logs route wall time for p95-style ops review.
 * Does not change response bodies or status codes.
 */
export async function withRouteTiming<T>(
  log: FastifyBaseLogger,
  route: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    log.info({ route, ms: Date.now() - started }, 'route_timing');
  }
}
