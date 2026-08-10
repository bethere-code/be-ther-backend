import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { CalendarModel } from '../../models/calendar.model.js';
import { CommentLikeModel } from '../../models/comment-like.model.js';
import { CommentModel } from '../../models/comment.model.js';
import { LikeModel } from '../../models/like.model.js';
import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { PostReportModel } from '../../models/post-report.model.js';
import { PostViewModel } from '../../models/post-view.model.js';
import { ProfileCalendarHiddenModel } from '../../models/profile-calendar-hidden.model.js';
import { areMutualFollowers } from '../../services/follow.service.js';
import { UserModel } from '../../models/user.model.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';
import { isPostEventPast } from '../../utils/event-date.js';
import { searchPosts } from '../../services/search.service.js';

const COMMENT_AUTHOR_SELECT = 'username displayName avatarUrl';

type PopulatedCommentAuthor = {
  _id: Types.ObjectId;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
};

function mapCommentAuthor(author: PopulatedCommentAuthor | Types.ObjectId | null | undefined) {
  if (!author || author instanceof Types.ObjectId || !('_id' in author)) {
    return null;
  }
  const username = (author.username ?? '').trim();
  if (!username) return null;
  return {
    _id: String(author._id),
    username,
    displayName: (author.displayName ?? '').trim() || username,
    avatarUrl: author.avatarUrl ?? '',
  };
}

async function assertCanViewPost(
  post: { authorId: unknown; isPrivate?: boolean },
  viewerId: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!post.isPrivate || String(post.authorId) === viewerId) {
    return { ok: true };
  }
  const mutual = await areMutualFollowers(viewerId, String(post.authorId));
  if (!mutual) {
    return { ok: false, status: 403, message: 'Event is private' };
  }
  return { ok: true };
}

const captionSchema = z
  .string()
  .max(500, { message: 'Description must be 500 characters or less' })
  .optional();

const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const eventLocationSchema = z.object({
  placeId: z.string().max(300).optional(),
  name: z.string().min(1).max(300),
  formattedAddress: z.string().max(500).optional(),
  locality: z.string().max(200).optional(),
  street: z.string().max(300).optional(),
  area: z.string().max(200).optional(),
  city: z.string().max(200).optional(),
  district: z.string().max(200).optional(),
  state: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
  postalCode: z.string().max(40).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const createPostSchema = z.object({
  location: z.string().min(1).max(200),
  country: z.string().max(200).optional(),
  status: z.enum(['been', 'going', 'interested']),
  imageUrl: z.string().min(4),
  caption: captionSchema,
  isPrivate: z.boolean().optional(),
  taggedUsernames: z.array(z.string()).max(20).optional(),
  addToCalendar: z.boolean().optional(),
  eventDetails: z.object({
    type: z.enum(['event', 'place', 'concert']),
    date: z.string().optional(),
    time: z.string().optional(),
    venue: z.string().optional(),
    ticketUrl: z.string().optional(),
    eventLocation: eventLocationSchema,
    userLocation: latLngSchema.optional(),
  }),
});


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

      const result = await searchPosts({
        query,
        country: country || undefined,
        viewerId: req.userId!,
        skip,
        limit: 10,
      });

      return reply.send({
        ok: true,
        data: { items: result.items, nextSkip: result.nextSkip },
      });
    },
  );

  app.get(
    '/api/v1/posts/:id',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const post = await PostModel.findOne({
        _id: postId,
        $or: [{ isPrivate: false }, { authorId: userId }],
      })
        .populate('authorId', 'username displayName avatarUrl')
        .lean();

      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const [enriched] = await enrichPostsForViewer([post as never], userId);
      return reply.send({ ok: true, data: { post: enriched } });
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
      const eventDetails = parsed.data.eventDetails;
      const eventLocation = eventDetails.eventLocation;
      const countryFromPlace =
        eventLocation.country?.trim() ||
        eventLocation.city?.trim() ||
        parsed.data.country?.trim() ||
        '';

      const post = await PostModel.create({
        authorId,
        location: parsed.data.location,
        country: countryFromPlace,
        status: parsed.data.status,
        imageUrl: parsed.data.imageUrl,
        caption: parsed.data.caption ?? '',
        isPrivate: parsed.data.isPrivate ?? false,
        taggedUserIds: taggedIds,
        eventDetails: {
          ...eventDetails,
          venue: eventDetails.venue?.trim() || eventLocation.name.trim() || undefined,
        },
      });
      await UserModel.updateOne(
        { _id: authorId },
        { $inc: { placesVisited: 1, eventsCount: 1 } },
      );

      // Author's own event always lands on their calendar with the RSVP they picked.
      const authorStatus =
        parsed.data.status === 'interested' ? 'interested' : 'going';
      let inCalendar = false;
      const existing = await CalendarModel.findOne({ postId: post._id, userId: authorId });
      if (!existing) {
        await CalendarModel.create({
          postId: post._id,
          userId: authorId,
          status: authorStatus,
        });
        await PostModel.updateOne({ _id: post._id }, { $inc: { calendarCount: 1 } });
      } else if (existing.status !== authorStatus) {
        existing.status = authorStatus;
        await existing.save();
      }
      inCalendar = true;

      const json = post.toJSON() as Record<string, unknown>;
      return reply.send({
        ok: true,
        data: {
          ...json,
          postId: String(post._id),
          inCalendar,
          calendarStatus: authorStatus,
        },
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
        const mutual = await areMutualFollowers(userId, String(post.authorId));
        await NotificationModel.create({
          userId: post.authorId,
          type: 'wishlist',
          actorUserId: userId,
          postId,
          mutualFollow: mutual,
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
      const parsed = z
        .object({
          status: z.enum(['interested', 'going', 'none']).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }

      // Legacy toggle when body omitted: add as going, or remove if present.
      const requested =
        parsed.data.status ??
        null;

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

      const isAuthor = String(post.authorId) === userId;

      // Author stays on calendar forever — can switch Interested ↔ Going only.
      if (isAuthor) {
        if (requested === 'none') {
          return reply.status(400).send({
            ok: false,
            error: {
              message: 'You cannot remove your own event from the calendar. Delete the event instead.',
            },
          });
        }
        const nextStatus: 'interested' | 'going' =
          requested === 'interested' ? 'interested' : 'going';
        const existingOwn = await CalendarModel.findOne({ postId, userId });
        if (!existingOwn) {
          await CalendarModel.create({ postId, userId, status: nextStatus });
          await PostModel.updateOne({ _id: postId }, { $inc: { calendarCount: 1 } });
        } else if (existingOwn.status !== nextStatus) {
          existingOwn.status = nextStatus;
          await existingOwn.save();
        }
        if (post.status === 'interested' || post.status === 'going') {
          await PostModel.updateOne({ _id: postId }, { $set: { status: nextStatus } });
        }
        return reply.send({
          ok: true,
          data: { inCalendar: true, calendarStatus: nextStatus },
        });
      }

      const existing = await CalendarModel.findOne({ postId, userId });

      // Resolve intent for legacy clients with empty body.
      let nextStatus: 'interested' | 'going' | 'none';
      if (requested != null) {
        nextStatus = requested;
      } else {
        nextStatus = existing ? 'none' : 'going';
      }

      if (nextStatus === 'none') {
        if (existing) {
          await existing.deleteOne();
          await PostModel.updateOne({ _id: postId }, { $inc: { calendarCount: -1 } });
        }
        return reply.send({
          ok: true,
          data: { inCalendar: false, calendarStatus: null },
        });
      }

      if (isPostEventPast(post)) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'Cannot add past events to calendar' },
        });
      }

      if (existing) {
        if (existing.status !== nextStatus) {
          existing.status = nextStatus;
          await existing.save();
        }
        return reply.send({
          ok: true,
          data: { inCalendar: true, calendarStatus: nextStatus },
        });
      }

      await CalendarModel.create({ postId, userId, status: nextStatus });
      await PostModel.updateOne({ _id: postId }, { $inc: { calendarCount: 1 } });

      const mutual = await areMutualFollowers(userId, String(post.authorId));
      await NotificationModel.create({
        userId: post.authorId,
        type: 'calendar',
        actorUserId: userId,
        postId,
        mutualFollow: mutual,
      });

      return reply.send({
        ok: true,
        data: { inCalendar: true, calendarStatus: nextStatus },
      });
    },
  );

  /**
   * Record a unique view for the authenticated viewer.
   * Idempotent — duplicate hits do not bump viewCount.
   * Authors do not count their own opens.
   */
  app.post(
    '/api/v1/posts/:id/view',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const post = await PostModel.findById(postId).select('authorId isPrivate viewCount').lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const currentCount = Math.max(0, Number(post.viewCount ?? 0) || 0);

      // Owner opens never count as views.
      if (String(post.authorId) === userId) {
        return reply.send({
          ok: true,
          data: { counted: false, viewCount: currentCount },
        });
      }

      if (post.isPrivate) {
        const mutual = await areMutualFollowers(userId, String(post.authorId));
        if (!mutual) {
          return reply.status(403).send({ ok: false, error: { message: 'Event is private' } });
        }
      }

      try {
        await PostViewModel.create({ postId, userId });
      } catch (err: unknown) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as { code?: number }).code
            : undefined;
        // Duplicate key — already counted this viewer.
        if (code === 11000) {
          return reply.send({
            ok: true,
            data: { counted: false, viewCount: currentCount },
          });
        }
        throw err;
      }

      const updated = await PostModel.findByIdAndUpdate(
        postId,
        { $inc: { viewCount: 1 } },
        { new: true, select: 'viewCount' },
      ).lean();

      return reply.send({
        ok: true,
        data: {
          counted: true,
          viewCount: Math.max(0, Number(updated?.viewCount ?? currentCount + 1) || 0),
        },
      });
    },
  );

  app.get(
    '/api/v1/posts/:id/attendees',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;
      const q = req.query as { skip?: string };
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = 40;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const postObjectId = new Types.ObjectId(postId);
      const post = await PostModel.findById(postObjectId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      if (post.isPrivate && String(post.authorId) !== userId) {
        const mutual = await areMutualFollowers(userId, String(post.authorId));
        if (!mutual) {
          return reply.status(403).send({ ok: false, error: { message: 'Event is private' } });
        }
      }

      const [total, rows] = await Promise.all([
        CalendarModel.countDocuments({ postId: postObjectId }),
        CalendarModel.find({ postId: postObjectId })
          .sort({ createdAt: 1, _id: 1 })
          .skip(skip)
          .limit(limit)
          .populate('userId', 'username displayName avatarUrl')
          .lean(),
      ]);

      // Heal drift: feed may show calendarCount while rows were deleted.
      if (skip === 0 && typeof post.calendarCount === 'number' && post.calendarCount !== total) {
        void PostModel.updateOne({ _id: postObjectId }, { $set: { calendarCount: total } });
      }

      const items = rows
        .map((row) => {
          const u = row.userId as
            | { _id?: Types.ObjectId; username?: string; displayName?: string; avatarUrl?: string }
            | Types.ObjectId
            | null
            | undefined;
          // Deleted / missing user — skip rather than blank rows.
          if (!u || u instanceof Types.ObjectId || !u._id) return null;
          const username = (u.username ?? '').trim();
          if (!username) return null;
          return {
            _id: String(u._id),
            username,
            displayName: (u.displayName ?? '').trim() || username,
            avatarUrl: u.avatarUrl ?? '',
          };
        })
        .filter(Boolean);

      const hasMore = skip + rows.length < total;
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          nextSkip: hasMore ? skip + limit : null,
        },
      });
    },
  );

  app.get(
    '/api/v1/posts/:id/likes',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;
      const q = req.query as { skip?: string };
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = 40;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const postObjectId = new Types.ObjectId(postId);
      const post = await PostModel.findById(postObjectId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const access = await assertCanViewPost(post, userId);
      if (!access.ok) {
        return reply.status(access.status).send({ ok: false, error: { message: access.message } });
      }

      const [total, rows] = await Promise.all([
        LikeModel.countDocuments({ postId: postObjectId }),
        LikeModel.find({ postId: postObjectId })
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .populate('userId', COMMENT_AUTHOR_SELECT)
          .lean(),
      ]);

      if (skip === 0 && typeof post.likesCount === 'number' && post.likesCount !== total) {
        void PostModel.updateOne({ _id: postObjectId }, { $set: { likesCount: total } });
      }

      const items = rows
        .map((row) => {
          const mapped = mapCommentAuthor(
            row.userId as PopulatedCommentAuthor | Types.ObjectId | null | undefined,
          );
          return mapped;
        })
        .filter(Boolean);

      const hasMore = skip + rows.length < total;
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          nextSkip: hasMore ? skip + limit : null,
        },
      });
    },
  );

  app.get(
    '/api/v1/posts/:id/comments',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;
      const q = req.query as { skip?: string };
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = 40;

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const postObjectId = new Types.ObjectId(postId);
      const post = await PostModel.findById(postObjectId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const access = await assertCanViewPost(post, userId);
      if (!access.ok) {
        return reply.status(access.status).send({ ok: false, error: { message: access.message } });
      }

      const [total, rows] = await Promise.all([
        CommentModel.countDocuments({ postId: postObjectId }),
        CommentModel.find({ postId: postObjectId })
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .populate('authorId', COMMENT_AUTHOR_SELECT)
          .lean(),
      ]);

      if (skip === 0 && typeof post.commentsCount === 'number' && post.commentsCount !== total) {
        void PostModel.updateOne({ _id: postObjectId }, { $set: { commentsCount: total } });
      }

      const commentIds = rows.map((r) => r._id);
      const likedRows =
        commentIds.length === 0
          ? []
          : await CommentLikeModel.find({
              userId,
              commentId: { $in: commentIds },
            })
              .select('commentId')
              .lean();
      const likedSet = new Set(likedRows.map((l) => String(l.commentId)));

      const items = rows
        .map((row) => {
          const author = mapCommentAuthor(
            row.authorId as PopulatedCommentAuthor | Types.ObjectId | null | undefined,
          );
          if (!author) return null;
          return {
            _id: String(row._id),
            postId: String(row.postId),
            text: row.text,
            likesCount: Math.max(0, Number(row.likesCount ?? 0) || 0),
            liked: likedSet.has(String(row._id)),
            createdAt: row.createdAt,
            author,
          };
        })
        .filter(Boolean);

      const hasMore = skip + rows.length < total;
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          nextSkip: hasMore ? skip + limit : null,
        },
      });
    },
  );

  app.post(
    '/api/v1/posts/:id/comments',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const postId = (req.params as { id: string }).id;
      const userId = req.userId!;
      const parsed = z
        .object({
          text: z.string().trim().min(1).max(500),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }

      if (!Types.ObjectId.isValid(postId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid post id' } });
      }

      const postObjectId = new Types.ObjectId(postId);
      const post = await PostModel.findById(postObjectId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const access = await assertCanViewPost(post, userId);
      if (!access.ok) {
        return reply.status(access.status).send({ ok: false, error: { message: access.message } });
      }

      const comment = await CommentModel.create({
        postId: postObjectId,
        authorId: userId,
        text: parsed.data.text,
      });
      await PostModel.updateOne({ _id: postObjectId }, { $inc: { commentsCount: 1 } });

      const populated = await CommentModel.findById(comment._id)
        .populate('authorId', COMMENT_AUTHOR_SELECT)
        .lean();
      const author = mapCommentAuthor(
        populated?.authorId as PopulatedCommentAuthor | Types.ObjectId | null | undefined,
      );

      return reply.send({
        ok: true,
        data: {
          _id: String(comment._id),
          postId,
          text: comment.text,
          likesCount: 0,
          liked: false,
          createdAt: comment.createdAt,
          author,
        },
      });
    },
  );

  app.delete(
    '/api/v1/comments/:id',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const commentId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(commentId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid comment id' } });
      }

      const comment = await CommentModel.findById(commentId).lean();
      if (!comment) {
        return reply.status(404).send({ ok: false, error: { message: 'Comment not found' } });
      }

      if (String(comment.authorId) !== userId) {
        return reply.status(403).send({
          ok: false,
          error: { message: 'Only the comment author can delete this comment' },
        });
      }

      await Promise.all([
        CommentModel.deleteOne({ _id: commentId }),
        CommentLikeModel.deleteMany({ commentId }),
        PostModel.updateOne({ _id: comment.postId }, { $inc: { commentsCount: -1 } }),
      ]);
      await PostModel.updateOne(
        { _id: comment.postId, commentsCount: { $lt: 0 } },
        { $set: { commentsCount: 0 } },
      );

      return reply.send({ ok: true, data: { deleted: true } });
    },
  );

  app.post(
    '/api/v1/comments/:id/like',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const commentId = (req.params as { id: string }).id;
      const userId = req.userId!;

      if (!Types.ObjectId.isValid(commentId)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid comment id' } });
      }

      const comment = await CommentModel.findById(commentId).lean();
      if (!comment) {
        return reply.status(404).send({ ok: false, error: { message: 'Comment not found' } });
      }

      const post = await PostModel.findById(comment.postId).lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      const access = await assertCanViewPost(post, userId);
      if (!access.ok) {
        return reply.status(access.status).send({ ok: false, error: { message: access.message } });
      }

      const existing = await CommentLikeModel.findOne({ commentId, userId });
      if (existing) {
        await existing.deleteOne();
        await CommentModel.updateOne({ _id: commentId }, { $inc: { likesCount: -1 } });
        const updated = await CommentModel.findById(commentId).select('likesCount').lean();
        return reply.send({
          ok: true,
          data: {
            liked: false,
            likesCount: Math.max(0, Number(updated?.likesCount ?? 0) || 0),
          },
        });
      }

      await CommentLikeModel.create({ commentId, userId });
      await CommentModel.updateOne({ _id: commentId }, { $inc: { likesCount: 1 } });
      const updated = await CommentModel.findById(commentId).select('likesCount').lean();
      return reply.send({
        ok: true,
        data: {
          liked: true,
          likesCount: Math.max(0, Number(updated?.likesCount ?? 0) || 0),
        },
      });
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

  /** Unhide — same resource as hide (DELETE) or dedicated POST. */
  app.delete(
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

      await ProfileCalendarHiddenModel.deleteOne({ profileUserId: userId, postId });

      return reply.send({ ok: true, data: { hiddenOnProfile: false } });
    },
  );

  app.post(
    '/api/v1/posts/:id/unhide-on-profile',
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

      await ProfileCalendarHiddenModel.deleteOne({ profileUserId: userId, postId });

      return reply.send({ ok: true, data: { hiddenOnProfile: false } });
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

      if (isPostEventPast(post)) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'Cannot change attendance for past events' },
        });
      }

      const calendarEntry = await CalendarModel.findOne({ postId, userId });
      const isAuthor = String(post.authorId) === userId;

      // Non-authors leave the calendar; authors keep their own event on calendar.
      if (calendarEntry && !isAuthor) {
        await calendarEntry.deleteOne();
        await PostModel.updateOne({ _id: postId }, { $inc: { calendarCount: -1 } });
      }

      let status = post.status;
      if (isAuthor && post.status === 'going') {
        post.status = 'interested';
        await post.save();
        status = 'interested';
      }

      return reply.send({
        ok: true,
        data: { inCalendar: isAuthor ? true : false, status },
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

      const commentIds = (
        await CommentModel.find({ postId }).select('_id').lean()
      ).map((c) => c._id);

      await Promise.all([
        LikeModel.deleteMany({ postId }),
        BookmarkModel.deleteMany({ postId }),
        CalendarModel.deleteMany({ postId }),
        NotificationModel.deleteMany({ postId }),
        ProfileCalendarHiddenModel.deleteMany({ postId }),
        CommentModel.deleteMany({ postId }),
        commentIds.length > 0
          ? CommentLikeModel.deleteMany({ commentId: { $in: commentIds } })
          : Promise.resolve(),
        PostModel.deleteOne({ _id: postId }),
        UserModel.updateOne({ _id: userId }, { $inc: { eventsCount: -1 } }),
      ]);
      await UserModel.updateOne(
        { _id: userId, eventsCount: { $lt: 0 } },
        { $set: { eventsCount: 0 } },
      );

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
