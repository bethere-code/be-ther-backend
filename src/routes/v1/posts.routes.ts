import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { CalendarModel } from '../../models/calendar.model.js';
import { LikeModel } from '../../models/like.model.js';
import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { ProfileStarModel } from '../../models/profile-star.model.js';
import { UserModel } from '../../models/user.model.js';

const createPostSchema = z.object({
  location: z.string().min(1).max(200),
  country: z.string().max(200).optional(),
  status: z.enum(['been', 'going', 'interested']),
  imageUrl: z.string().min(4),
  caption: z.string().max(2000).optional(),
  isPrivate: z.boolean().optional(),
  taggedUsernames: z.array(z.string()).max(20).optional(),
  eventDetails: z
    .object({
      type: z.enum(['event', 'place', 'concert']),
      date: z.string().optional(),
      time: z.string().optional(),
      venue: z.string().optional(),
      ticketUrl: z.string().optional(),
    })
    .optional(),
});

async function mutualStarExists(a: string, b: string): Promise<boolean> {
  const one = await ProfileStarModel.exists({ fromUserId: a, toUserId: b });
  const two = await ProfileStarModel.exists({ fromUserId: b, toUserId: a });
  return Boolean(one && two);
}

export async function registerPostsV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/posts/feed',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const q = req.query as { skip?: string };
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = 10;

      const posts = await PostModel.find({
        $or: [{ isPrivate: false }, { authorId: req.userId }],
      })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit + 1)
        .populate('authorId', 'username displayName avatarUrl')
        .lean();

      const page = posts.slice(0, limit);
      const hasMore = posts.length > limit;
      return reply.send({ ok: true, data: { items: page, nextSkip: hasMore ? skip + limit : null } });
    },
  );

  app.get(
    '/api/v1/posts/search',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const q = req.query as { query?: string; country?: string; skip?: string };
      const query = q.query?.trim() ?? '';
      const country = q.country?.trim();
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = 10;

      const filter: any = {
        $or: [{ isPrivate: false }, { authorId: req.userId }],
      };

      if (query) {
        filter.location = { $regex: query, $options: 'i' };
      }

      if (country) {
        filter.country = country;
      }

      const posts = await PostModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit + 1)
        .populate('authorId', 'username displayName avatarUrl')
        .lean();

      const page = posts.slice(0, limit);
      const hasMore = posts.length > limit;
      return reply.send({ ok: true, data: { items: page, nextSkip: hasMore ? skip + limit : null } });
    },
  );

  app.post(
    '/api/v1/posts',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = createPostSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const authorId = req.userId!;
      const taggedIds: Types.ObjectId[] = [];
      if (parsed.data.taggedUsernames?.length) {
        const users = await UserModel.find({ username: { $in: parsed.data.taggedUsernames } }).select('_id');
        taggedIds.push(...users.map((u) => u._id as Types.ObjectId));
      }
      const post = await PostModel.create({
        authorId,
        location: parsed.data.location,
        country: parsed.data.country ?? '',
        status: parsed.data.status,
        imageUrl: parsed.data.imageUrl,
        caption: parsed.data.caption ?? '',
        isPrivate: parsed.data.isPrivate ?? false,
        taggedUserIds: taggedIds,
        eventDetails: parsed.data.eventDetails,
      });
      await UserModel.updateOne({ _id: authorId }, { $inc: { placesVisited: 1 } });
      return reply.send({ ok: true, data: post.toJSON() });
    },
  );

  app.post(
    '/api/v1/posts/:id/like',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;
      const existing = await LikeModel.findOne({ postId, userId });
      if (existing) {
        await existing.deleteOne();
        await PostModel.updateOne({ _id: postId }, { $inc: { likesCount: -1 } });
        return reply.send({ ok: true, data: { liked: false } });
      }
      await LikeModel.create({ postId, userId });
      await PostModel.updateOne({ _id: postId }, { $inc: { likesCount: 1 } });
      return reply.send({ ok: true, data: { liked: true } });
    },
  );

  app.post(
    '/api/v1/posts/:id/bookmark',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;
      const post = await PostModel.findById(postId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }
      const existing = await BookmarkModel.findOne({ postId, userId });
      if (existing) {
        await existing.deleteOne();
        return reply.send({ ok: true, data: { bookmarked: false } });
      }
      await BookmarkModel.create({ postId, userId });
      if (String(post.authorId) !== userId) {
        const mutual = await mutualStarExists(userId, String(post.authorId));
        await NotificationModel.create({
          userId: post.authorId,
          type: 'wishlist',
          actorUserId: userId,
          postId,
          mutualStar: mutual,
        });
      }
      return reply.send({ ok: true, data: { bookmarked: true } });
    },
  );

  app.post(
    '/api/v1/posts/:id/calendar',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      const post = await PostModel.findById(postId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      if (post.isPrivate && String(post.authorId) !== userId) {
        return reply.status(403).send({ ok: false, error: { message: 'Cannot add private event to calendar' } });
      }

      const existing = await CalendarModel.findOne({ postId, userId });
      if (existing) {
        await existing.deleteOne();
        await PostModel.updateOne({ _id: postId }, { $inc: { calendarCount: -1 } });
        return reply.send({ ok: true, data: { inCalendar: false } });
      }

      await CalendarModel.create({ postId, userId });
      await PostModel.updateOne({ _id: postId }, { $inc: { calendarCount: 1 } });

      if (String(post.authorId) !== userId) {
        const mutual = await mutualStarExists(userId, String(post.authorId));
        await NotificationModel.create({
          userId: post.authorId,
          type: 'calendar',
          actorUserId: userId,
          postId,
          mutualStar: mutual,
        });
      }

      return reply.send({ ok: true, data: { inCalendar: true } });
    },
  );
}
