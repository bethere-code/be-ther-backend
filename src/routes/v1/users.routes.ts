import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { ProfileStarModel } from '../../models/profile-star.model.js';
import { UserModel } from '../../models/user.model.js';

const patchUserSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
  settings: z
    .object({
      isPrivateProfile: z.boolean().optional(),
      pushEnabled: z.boolean().optional(),
      calendarView: z.enum(['full', 'events-only']).optional(),
    })
    .optional(),
});

export async function registerUsersV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/users/me',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const user = await UserModel.findById(req.userId).lean();
      if (!user) {
        // Treat missing user for an authenticated token as stale/invalid auth state.
        return reply.status(401).send({ ok: false, error: { message: 'Invalid token user' } });
      }
      return reply.send({ ok: true, data: user });
    },
  );

  app.patch(
    '/api/v1/users/me',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = patchUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const user = await UserModel.findById(req.userId);
      if (!user) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      if (parsed.data.displayName !== undefined) user.displayName = parsed.data.displayName;
      if (parsed.data.bio !== undefined) user.bio = parsed.data.bio;
      if (parsed.data.avatarUrl !== undefined) user.avatarUrl = parsed.data.avatarUrl;
      if (parsed.data.settings) {
        const current = (user.toObject().settings ?? {}) as Record<string, unknown>;
        user.set('settings', { ...current, ...parsed.data.settings });
        user.markModified('settings');
      }
      await user.save();
      return reply.send({ ok: true, data: user.toJSON() });
    },
  );

  app.get('/api/v1/users/:username', { preHandler: [app.authenticate] }, async (req, reply) => {
    const username = String((req.params as { username: string }).username).toLowerCase();
    const user = await UserModel.findOne({ username }).lean();
    if (!user) {
      return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
    }
    if (user.settings?.isPrivateProfile && String(user._id) !== req.userId) {
      const starred = await ProfileStarModel.exists({ fromUserId: req.userId, toUserId: user._id });
      if (!starred) {
        return reply.status(403).send({ ok: false, error: { message: 'Private profile' } });
      }
    }
    return reply.send({ ok: true, data: user });
  });

  app.post(
    '/api/v1/users/:username/star',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const target = await UserModel.findOne({ username });
      if (!target) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      const from = req.userId!;
      const to = String(target._id);
      if (from === to) {
        return reply.status(400).send({ ok: false, error: { message: 'Cannot star yourself' } });
      }
      const existing = await ProfileStarModel.findOne({ fromUserId: from, toUserId: to });
      if (existing) {
        await existing.deleteOne();
        await UserModel.updateOne({ _id: to }, { $inc: { starsReceived: -1 } });
        return reply.send({ ok: true, data: { starred: false } });
      }
      await ProfileStarModel.create({ fromUserId: from, toUserId: to });
      await UserModel.updateOne({ _id: to }, { $inc: { starsReceived: 1 } });
      const mutual = await ProfileStarModel.exists({ fromUserId: to, toUserId: from });
      await NotificationModel.create({
        userId: to,
        type: 'star',
        actorUserId: from,
        mutualStar: Boolean(mutual),
      });
      return reply.send({ ok: true, data: { starred: true } });
    },
  );

  app.get(
    '/api/v1/users/:username/calendar',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const user = await UserModel.findOne({ username }).select('_id').lean();
      if (!user) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      const posts = await PostModel.find({ authorId: user._id })
        .select('location status imageUrl createdAt eventDetails country')
        .sort({ createdAt: -1 })
        .lean();
      return reply.send({ ok: true, data: { items: posts } });
    },
  );
}
