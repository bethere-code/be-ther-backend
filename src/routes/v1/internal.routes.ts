import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { Env } from '../../config/env.js';
import { runNudgeTick } from '../../services/event-nudge.service.js';

function secretOk(provided: string | undefined, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Cron-friendly tick — Authorization: Bearer <NUDGE_TICK_SECRET>. */
export async function registerInternalV1Routes(
  app: FastifyInstance,
  env: Env,
): Promise<void> {
  app.post('/api/v1/internal/nudge-tick', async (req, reply) => {
    const expected = env.NUDGE_TICK_SECRET?.trim();
    if (!expected) {
      return reply.status(503).send({
        ok: false,
        error: { message: 'NUDGE_TICK_SECRET not configured' },
      });
    }
    const header = req.headers.authorization?.trim() ?? '';
    const token = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : String(req.headers['x-nudge-tick-secret'] ?? '');
    if (!secretOk(token, expected)) {
      return reply.status(401).send({ ok: false, error: { message: 'Unauthorized' } });
    }
    const result = await runNudgeTick();
    return reply.send({ ok: true, data: result });
  });
}
