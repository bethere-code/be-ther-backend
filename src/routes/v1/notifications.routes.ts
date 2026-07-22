import type { FastifyInstance } from 'fastify';

import { NotificationModel } from '../../models/notification.model.js';

export async function registerNotificationsV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/notifications',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const items = await NotificationModel.find({ userId: req.userId })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('actorUserId', 'username displayName avatarUrl')
        .populate('postId', 'location imageUrl caption status eventDetails')
        .lean();
      return reply.send({ ok: true, data: { items } });
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
