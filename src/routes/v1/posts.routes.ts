import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { CalendarModel } from '../../models/calendar.model.js';
import { LikeModel } from '../../models/like.model.js';
import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { PostReportModel } from '../../models/post-report.model.js';
import { ProfileCalendarHiddenModel } from '../../models/profile-calendar-hidden.model.js';
import { ProfileStarModel } from '../../models/profile-star.model.js';
import { UserModel } from '../../models/user.model.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';

const createPostSchema = z.object({
  location: z.string().min(1).max(200),
  country: z.string().max(200).optional(),
  status: z.enum(['been', 'going', 'interested']),
  imageUrl: z.string().min(4),
  caption: z.string().max(2000).optional(),
  isPrivate: z.boolean().optional(),
  taggedUsernames: z.array(z.string()).max(20).optional(),
  addToCalendar: z.boolean().optional(),
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
        .populate('authorId', 'username displayName avatarUrl starsReceived')
        .lean();

      const page = posts.slice(0, limit);
      const hasMore = posts.length > limit;
      const enriched = await enrichPostsForViewer(page as never[], req.userId!);
      return reply.send({ ok: true, data: { items: enriched, nextSkip: hasMore ? skip + limit : null } });
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
        .populate('authorId', 'username displayName avatarUrl starsReceived')
        .lean();

      const page = posts.slice(0, limit);
      const hasMore = posts.length > limit;
      const enriched = await enrichPostsForViewer(page as never[], req.userId!);
      return reply.send({ ok: true, data: { items: enriched, nextSkip: hasMore ? skip + limit : null } });
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

      let inCalendar = false;
      if (parsed.data.addToCalendar) {
        const existing = await CalendarModel.findOne({ postId: post._id, userId: authorId });
        if (!existing) {
          await CalendarModel.create({ postId: post._id, userId: authorId });
          await PostModel.updateOne({ _id: post._id }, { $inc: { calendarCount: 1 } });
        }
        inCalendar = true;
      }

      const json = post.toJSON() as Record<string, unknown>;
      return reply.send({
        ok: true,
        data: { ...json, postId: String(post._id), inCalendar },
      });
    },
  );

  app.post(
    '/api/v1/posts/:id/like',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const post = await PostModel.findById(postId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

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

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

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

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

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

  app.post(
    '/api/v1/posts/:id/hide-on-profile',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const post = await PostModel.findById(postId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const isAuthor = String(post.authorId) === userId;
      const onCalendar = await CalendarModel.exists({ postId, userId });
      if (!isAuthor && !onCalendar) {
        return reply.status(403).send({
          ok: false,
          error: { message: 'Event is not on your profile calendar' },
        });
      }

      const alreadyHidden = await ProfileCalendarHiddenModel.exists({ profileUserId: userId, postId });
      if (!alreadyHidden) {
        await ProfileCalendarHiddenModel.create({ profileUserId: userId, postId });
      }

      return reply.send({ ok: true, data: { hiddenOnProfile: true } });
    },
  );

  app.post(
    '/api/v1/posts/:id/not-going',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const post = await PostModel.findById(postId);
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const calendarEntry = await CalendarModel.findOne({ postId, userId });
      if (calendarEntry) {
        await calendarEntry.deleteOne();
        await PostModel.updateOne({ _id: postId }, { $inc: { calendarCount: -1 } });
      }

      let status = post.status;
      if (String(post.authorId) === userId && post.status === 'going') {
        post.status = 'interested';
        await post.save();
        status = 'interested';
      }

      return reply.send({
        ok: true,
        data: { inCalendar: false, status },
      });
    },
  );

  app.delete(
    '/api/v1/posts/:id',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const post = await PostModel.findById(postId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      if (String(post.authorId) !== userId) {
        return reply.status(403).send({ ok: false, error: { message: 'Only the author can delete this event' } });
      }

      await Promise.all([
        LikeModel.deleteMany({ postId }),
        BookmarkModel.deleteMany({ postId }),
        CalendarModel.deleteMany({ postId }),
        NotificationModel.deleteMany({ postId }),
        ProfileCalendarHiddenModel.deleteMany({ postId }),
        PostModel.deleteOne({ _id: postId }),
      ]);

      return reply.send({ ok: true, data: { deleted: true } });
    },
  );

  const postReportSchema = z
    .object({
      type: z.enum(['event_cancelled', 'spam', 'bug']),
      details: z.string().max(2000).optional(),
    })
    .superRefine((data, ctx) => {
      const text = data.details?.trim() ?? '';
      if (data.type === 'bug' && text.length < 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Bug report requires a description (at least 3 characters)',
          path: ['details'],
        });
      }
    });

  app.post(
    '/api/v1/posts/:id/reports',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const parsed = postReportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }

      const post = await PostModel.findById(postId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const details = parsed.data.details?.trim() ?? '';
      const existing = await PostReportModel.findOne({
        reporterId: userId,
        postId,
        type: parsed.data.type,
      });
      if (existing) {
        return reply.status(409).send({
          ok: false,
          error: { message: 'You already submitted this report for this event' },
        });
      }

      await PostReportModel.create({
        reporterId: userId,
        postId,
        type: parsed.data.type,
        details,
      });

      return reply.send({
        ok: true,
        data: {
          reported: true,
          type: parsed.data.type,
          thankYou: parsed.data.type === 'bug',
        },
      });
    },
  );
}
