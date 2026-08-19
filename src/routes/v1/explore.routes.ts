import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { areMutualFollowers } from '../../services/follow.service.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';
import { compareExplorePosts, isPostEventPast } from '../../utils/event-date.js';
import { mapPostToExploreItem } from '../../utils/map-post-to-explore.js';
import { canViewerSeePost, postsVisibleToViewerFilter } from '../../utils/post-visibility.js';

const EXPLORE_SCAN_LIMIT = 400;
const EXPLORE_PAGE_SIZE = 50;
const AUTHOR_SELECT = 'username displayName avatarUrl';

export async function registerExploreV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/explore/events',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const q = req.query as { skip?: string };
      const skip = Math.max(0, Number(q.skip ?? 0) || 0);
      const limit = EXPLORE_PAGE_SIZE;

      // Same window as before (400 newest visible posts), one round-trip.
      const scanned = await PostModel.find(await postsVisibleToViewerFilter(req.userId!))
        .sort({ createdAt: -1, _id: -1 })
        .limit(EXPLORE_SCAN_LIMIT)
        .lean();

      const upcoming = scanned.filter((post) => !isPostEventPast(post as never));
      upcoming.sort((a, b) => compareExplorePosts(a as never, b as never));

      const page = upcoming.slice(skip, skip + limit);
      await PostModel.populate(page, { path: 'authorId', select: AUTHOR_SELECT });
      const enriched = await enrichPostsForViewer(page as never[], req.userId!);
      const items = enriched.map(mapPostToExploreItem);
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

      if (!(await canViewerSeePost(post, userId))) {
        return reply.status(403).send({ ok: false, error: { message: 'This event is not visible to you' } });
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
