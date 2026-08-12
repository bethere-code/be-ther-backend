import type { FastifyInstance } from 'fastify';

import { NotificationModel } from '../../models/notification.model.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';

export async function registerNotificationsV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/notifications',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const items = await NotificationModel.find({ userId: req.userId })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('actorUserId', 'username displayName avatarUrl')
        .populate({
          path: 'postId',
          select:
            'location imageUrl caption status eventDetails authorId likesCount commentsCount calendarCount',
          populate: { path: 'authorId', select: 'username displayName avatarUrl' },
        })
        .lean();

      // Attach the viewer's calendar / like state so opening an event from
      // alerts matches feed (e.g. INTERESTED instead of ADD TO CALENDAR).
      const posts: Record<string, unknown>[] = [];
      for (const n of items) {
        const p = n.postId;
        if (p != null && typeof p === 'object' && !('_bsontype' in p) && '_id' in p) {
          posts.push(p as Record<string, unknown>);
        }
      }
      const enrichedPosts = await enrichPostsForViewer(posts as never[], req.userId!);
      const byId = new Map(enrichedPosts.map((p) => [String(p._id), p]));

      const enrichedItems = items.map((n) => {
        const raw = n.postId;
        if (raw == null || typeof raw !== 'object' || !('_id' in raw)) return n;
        const id = String((raw as { _id: unknown })._id);
        const enriched = byId.get(id);
        if (!enriched) return n;
        return { ...n, postId: enriched };
      });

      return reply.send({ ok: true, data: { items: enrichedItems } });
    },
  );

  app.get(
    '/api/v1/notifications/unread-count',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const count = await NotificationModel.countDocuments({
        userId: req.userId,
        read: false,
      });
      return reply.send({ ok: true, data: { count } });
    },
  );

  app.patch(
    '/api/v1/notifications/:id/read',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const res = await NotificationModel.updateOne({ _id: id, userId: req.userId }, { $set: { read: true } });
      if (res.matchedCount === 0) {
        return reply.status(404).send({ ok: false, error: { message: 'Not found' } });
      }
      return reply.send({ ok: true, data: { read: true } });
    },
  );

  app.patch(
    '/api/v1/notifications/read-all',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      await NotificationModel.updateMany(
        { userId: req.userId, read: false },
        { $set: { read: true } },
      );
      return reply.send({ ok: true, data: { read: true } });
    },
  );
}
