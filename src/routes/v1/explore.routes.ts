import type { FastifyInstance } from 'fastify';

import { ExploreEventModel } from '../../models/explore-event.model.js';

export async function registerExploreV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/explore/events',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const type = String((req.query as { type?: string }).type ?? 'all');
      const filter: Record<string, unknown> = {};
      if (type === 'events') {
        filter.$or = [{ type: 'event' }, { type: 'concert' }];
      } else if (type === 'places') {
        filter.type = 'place';
      }
      const items = await ExploreEventModel.find(filter).sort({ trending: -1, attendees: -1 }).lean();
      return reply.send({ ok: true, data: { items } });
    },
  );
}
