import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { PostModel } from '../../models/post.model.js';
import { areMutualFollowers } from '../../services/follow.service.js';
import { createAndPushNotification } from '../../services/notification.service.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';
import { isPostEventPast, todayIsoLocal } from '../../utils/event-date.js';
import { mapPostToExploreItem } from '../../utils/map-post-to-explore.js';
import { canViewerSeePost, postsVisibleToViewerFilter } from '../../utils/post-visibility.js';
import { withRouteTiming } from '../../utils/route-timing.js';

const EXPLORE_PAGE_SIZE = 50;
const AUTHOR_SELECT = 'username displayName avatarUrl';

export async function registerExploreV1Routes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/explore/events',
    { preHandler: [app.authenticate] },
    async (req, reply) =>
      withRouteTiming(req.log, 'GET /api/v1/explore/events', async () => {
        const q = req.query as { skip?: string };
        const skip = Math.max(0, Number(q.skip ?? 0) || 0);
        const limit = EXPLORE_PAGE_SIZE;
        const today = todayIsoLocal();
        const visibility = await postsVisibleToViewerFilter(req.userId!);

        // App writes ISO YYYY-MM-DD — filter + sort on eventDetails.date (indexed).
        // Oversample + isPostEventPast trims same-day events past grace.
        const oversample = 15;
        const collected: Record<string, unknown>[] = [];
        let dbSkip = skip;
        let exhausted = false;

        while (collected.length < limit && !exhausted) {
          const need = limit - collected.length + oversample;
          const batch = await PostModel.find({
            $and: [visibility, { 'eventDetails.date': { $gte: today } }],
          })
            .sort({
              'eventDetails.date': 1,
              likesCount: -1,
              commentsCount: -1,
              createdAt: -1,
              _id: -1,
            })
            .skip(dbSkip)
            .limit(need)
            .populate('authorId', AUTHOR_SELECT)
            .lean();

          if (batch.length === 0) {
            exhausted = true;
            break;
          }

          dbSkip += batch.length;
          if (batch.length < need) exhausted = true;

          for (const post of batch) {
            if (isPostEventPast(post as never)) continue;
            collected.push(post as Record<string, unknown>);
            if (collected.length >= limit) break;
          }
        }

        const page = collected.slice(0, limit);
        const enriched = await enrichPostsForViewer(page as never[], req.userId!);
        const items = enriched.map(mapPostToExploreItem);
        const nextSkip = page.length < limit ? null : skip + limit;

        return reply.send({
          ok: true,
          data: { items, nextSkip },
        });
      }),
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
        await createAndPushNotification({
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
