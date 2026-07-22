import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { areMutualFollowers } from '../../services/follow.service.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';
import { isPostEventPast } from '../../utils/event-date.js';
import { mapPostToExploreItem } from '../../utils/map-post-to-explore.js';

export async function registerExploreV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/explore/events',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const q = req.query as { skip?: string };
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = 50;
      const batchSize = 80;
      const maxScan = 400;
      const upcoming: Record<string, unknown>[] = [];
      let cursor = 0;

      while (upcoming.length < skip + limit + 1 && cursor < maxScan) {
        const batch = await PostModel.find({
          $or: [{ isPrivate: false }, { authorId: req.userId }],
        })
          .sort({ likesCount: -1, createdAt: -1, _id: -1 })
          .skip(cursor)
          .limit(batchSize)
          .populate('authorId', 'username displayName avatarUrl')
          .lean();

        if (batch.length === 0) break;
        cursor += batch.length;

        const enriched = await enrichPostsForViewer(batch as never[], req.userId!);
        for (const post of enriched) {
          if (!isPostEventPast(post as never)) upcoming.push(post);
        }

        if (batch.length < batchSize) break;
      }

      const page = upcoming.slice(skip, skip + limit);
      const items = page.map(mapPostToExploreItem);
      const hasMore = upcoming.length > skip + limit;
      return reply.send({
        ok: true,
        data: { items, nextSkip: hasMore ? skip + limit : null },
      });
    },
  );

  /** Wishlist on explore items — backed by post bookmarks (same as feed). */
  app.post(
    '/api/v1/explore/events/:id/bookmark',
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
}
