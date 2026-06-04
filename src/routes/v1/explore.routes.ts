import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { ProfileStarModel } from '../../models/profile-star.model.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';
import { mapPostToExploreItem } from '../../utils/map-post-to-explore.js';

async function mutualStarExists(a: string, b: string): Promise<boolean> {
  const one = await ProfileStarModel.exists({ fromUserId: a, toUserId: b });
  const two = await ProfileStarModel.exists({ fromUserId: b, toUserId: a });
  return Boolean(one && two);
}

export async function registerExploreV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/explore/events',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const q = req.query as { skip?: string };
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = 50;

      const posts = await PostModel.find({
        $or: [{ isPrivate: false }, { authorId: req.userId }],
      })
        .sort({ likesCount: -1, createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'username displayName avatarUrl starsReceived')
        .lean();

      const enriched = await enrichPostsForViewer(posts as never[], req.userId!);
      const items = enriched.map(mapPostToExploreItem);

      const hasMore = posts.length === limit;
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
}
