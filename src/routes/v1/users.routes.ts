import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { CalendarModel } from '../../models/calendar.model.js';
import { FollowModel } from '../../models/follow.model.js';
import { PostModel } from '../../models/post.model.js';
import { ProfileCalendarHiddenModel } from '../../models/profile-calendar-hidden.model.js';
import { UserModel } from '../../models/user.model.js';
import { areMutualFollowers, isFollowing, toggleFollow } from '../../services/follow.service.js';
import { formatJoinedDate, parseEventDateToIso } from '../../utils/event-date.js';

/** Fields populated on calendar/feed authors. Badge paused — not included. */
const AUTHOR_SELECT = 'username displayName avatarUrl';

type PopulatedAuthor = {
  _id: Types.ObjectId;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
};

type LeanPost = {
  _id: Types.ObjectId;
  authorId: Types.ObjectId | PopulatedAuthor;
  location: string;
  country?: string;
  status: string;
  imageUrl: string;
  isPrivate?: boolean;
  eventDetails?: {
    date?: string;
    time?: string;
    venue?: string;
    ticketUrl?: string;
  };
  createdAt?: Date;
};

function mapAuthor(authorId: LeanPost['authorId']) {
  if (authorId && typeof authorId === 'object' && 'username' in authorId) {
    return {
      _id: String(authorId._id),
      username: authorId.username ?? '',
      displayName: authorId.displayName ?? authorId.username ?? '',
      avatarUrl: authorId.avatarUrl ?? '',
      // badge: paused — restore via computeMemberBadge when ready
      badge: null as string | null,
    };
  }
  if (authorId) {
    return { _id: String(authorId), username: '', displayName: '', avatarUrl: '', badge: null };
  }
  return null;
}

function mapPostToCalendarItem(
  post: LeanPost,
  source: 'authored' | 'calendar',
  bookmarked: boolean,
  extras?: {
    isAuthoredByViewer?: boolean;
    inCalendar?: boolean;
    hiddenOnProfile?: boolean;
  },
) {
  const date =
    parseEventDateToIso(post.eventDetails?.date) ??
    (post.createdAt ? new Date(post.createdAt).toISOString().slice(0, 10) : null);

  const country = String(post.country ?? '').trim();
  const venue = String(post.eventDetails?.venue ?? '').trim();
  const location = String(post.location ?? '').trim();
  let place = country;
  if (!place && venue && venue.toLowerCase() !== location.toLowerCase()) {
    place = venue;
  } else if (!place) {
    place = venue;
  }

  return {
    postId: String(post._id),
    date,
    location,
    title: location,
    imageUrl: post.imageUrl,
    status: post.status,
    venue,
    country,
    place: place || null,
    ticketUrl: post.eventDetails?.ticketUrl ?? null,
    time: post.eventDetails?.time ?? null,
    source,
    bookmarked,
    isAuthoredByMe: extras?.isAuthoredByViewer ?? false,
    inCalendar: extras?.inCalendar ?? false,
    hiddenOnProfile: extras?.hiddenOnProfile ?? false,
    authorId: mapAuthor(post.authorId),
  };
}

function clampCount(n: unknown): number {
  return Math.max(0, Number(n ?? 0));
}

async function enrichUserForViewer(
  user: Record<string, unknown>,
  viewerId: string | undefined,
): Promise<Record<string, unknown>> {
  const userId = String(user._id);
  const isOwnProfile = viewerId != null && userId === viewerId;
  let viewerFollows = false;
  let canDM = false;

  if (!isOwnProfile && viewerId) {
    viewerFollows = await isFollowing(viewerId, userId);
    if (viewerFollows) {
      canDM = await areMutualFollowers(viewerId, userId);
    }
  }

  // Prefer denormalized counters (O(1)). Fall back only if fields are missing on old docs.
  let eventsCount = user.eventsCount;
  let followersCount = user.followersCount;
  let followingCount = user.followingCount;
  if (eventsCount == null || followersCount == null || followingCount == null) {
    const [events, followers, following] = await Promise.all([
      eventsCount == null ? PostModel.countDocuments({ authorId: userId }) : Promise.resolve(null),
      followersCount == null
        ? FollowModel.countDocuments({ followingId: userId })
        : Promise.resolve(null),
      followingCount == null
        ? FollowModel.countDocuments({ followerId: userId })
        : Promise.resolve(null),
    ]);
    if (events != null) eventsCount = events;
    if (followers != null) followersCount = followers;
    if (following != null) followingCount = following;
  }

  const payload: Record<string, unknown> = {
    ...user,
    isOwnProfile,
    isFollowing: viewerFollows,
    canDM,
    eventsCount: clampCount(eventsCount),
    followersCount: clampCount(followersCount),
    followingCount: clampCount(followingCount),
    // badge: paused — restore when multi-signal badge logic lands
    badge: null,
    joined: formatJoinedDate(user.createdAt as Date | string | undefined),
  };
  if (!isOwnProfile) {
    delete payload.devicePermissions;
  }
  return payload;
}

const patchUserSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.union([z.string().url(), z.literal('')]).optional(),
  settings: z
    .object({
      isPrivateProfile: z.boolean().optional(),
      pushEnabled: z.boolean().optional(),
      calendarView: z.enum(['full', 'events-only']).optional(),
    })
    .optional(),
});

const permissionStatusSchema = z.enum([
  'granted',
  'denied',
  'limited',
  'provisional',
  'permanently_denied',
  'restricted',
  'unknown',
]);

const syncDevicePermissionsSchema = z.object({
  notification: permissionStatusSchema,
  location: permissionStatusSchema,
});

function permissionEntryFromStatus(status: z.infer<typeof permissionStatusSchema>) {
  const granted = status === 'granted' || status === 'limited' || status === 'provisional';
  return { granted, status, updatedAt: new Date() };
}

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
      const data = await enrichUserForViewer(user as Record<string, unknown>, req.userId);
      return reply.send({ ok: true, data });
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

  app.patch(
    '/api/v1/users/me/device-permissions',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = syncDevicePermissionsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }

      const user = await UserModel.findById(req.userId);
      if (!user) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }

      const current = (user.toObject().devicePermissions ?? {}) as Record<string, unknown>;
      user.set('devicePermissions', {
        ...current,
        notification: permissionEntryFromStatus(parsed.data.notification),
        location: permissionEntryFromStatus(parsed.data.location),
      });
      user.markModified('devicePermissions');
      await user.save();

      return reply.send({
        ok: true,
        data: {
          devicePermissions: user.toObject().devicePermissions,
        },
      });
    },
  );

  app.get('/api/v1/users/:username', { preHandler: [app.authenticate] }, async (req, reply) => {
    const username = String((req.params as { username: string }).username).toLowerCase();
    const user = await UserModel.findOne({ username }).lean();
    if (!user) {
      return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
    }
    if (user.settings?.isPrivateProfile && String(user._id) !== req.userId) {
      const follows = await isFollowing(req.userId!, String(user._id));
      if (!follows) {
        return reply.status(403).send({ ok: false, error: { message: 'Private profile' } });
      }
    }
    const data = await enrichUserForViewer(user as Record<string, unknown>, req.userId);
    return reply.send({ ok: true, data });
  });

  app.post(
    '/api/v1/users/:username/follow',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const target = await UserModel.findOne({ username }).select('_id').lean();
      if (!target) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      const followerId = req.userId!;
      const followingId = String(target._id);
      try {
        const result = await toggleFollow(followerId, followingId);
        return reply.send({
          ok: true,
          data: {
            following: result.following,
            followersCount: result.followersCount,
          },
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'CANNOT_FOLLOW_SELF') {
          return reply.status(400).send({ ok: false, error: { message: 'Cannot follow yourself' } });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/users/:username/calendar',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const user = await UserModel.findOne({ username }).select('_id settings').lean();
      if (!user) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }

      const viewerId = req.userId!;
      const isOwnProfile = String(user._id) === viewerId;

      if (user.settings?.isPrivateProfile && !isOwnProfile) {
        const follows = await isFollowing(viewerId, String(user._id));
        if (!follows) {
          return reply.status(403).send({ ok: false, error: { message: 'Private profile' } });
        }
      }

      const authored = await PostModel.find({ authorId: user._id })
        .select('authorId location status imageUrl createdAt eventDetails country isPrivate')
        .populate('authorId', AUTHOR_SELECT)
        .sort({ createdAt: -1 })
        .lean();

      const visibleAuthored = isOwnProfile
        ? authored
        : authored.filter((post) => !post.isPrivate);

      const hiddenOnProfile = await ProfileCalendarHiddenModel.find({ profileUserId: user._id })
        .select('postId')
        .lean();
      const hiddenSet = new Set(hiddenOnProfile.map((h) => String(h.postId)));

      const profileCalendar = await CalendarModel.find({ userId: user._id }).select('postId').lean();
      const profileCalendarSet = new Set(profileCalendar.map((c) => String(c.postId)));

      const postIds = new Set<string>();
      const mergedPosts: Array<{ post: LeanPost; source: 'authored' | 'calendar' }> = [];

      for (const post of visibleAuthored) {
        const id = String(post._id);
        if (!isOwnProfile && hiddenSet.has(id)) continue;
        if (postIds.has(id)) continue;
        postIds.add(id);
        mergedPosts.push({ post: post as LeanPost, source: 'authored' });
      }

      if (isOwnProfile) {
        const savedIds = profileCalendar.map((entry) => entry.postId);
        if (savedIds.length > 0) {
          const savedPosts = await PostModel.find({ _id: { $in: savedIds } })
            .select('authorId location status imageUrl createdAt eventDetails country isPrivate')
            .populate('authorId', AUTHOR_SELECT)
            .lean();
          for (const post of savedPosts) {
            const id = String(post._id);
            if (postIds.has(id)) continue;
            postIds.add(id);
            mergedPosts.push({ post: post as LeanPost, source: 'calendar' });
          }
        }
      }

      const bookmarkedSet = new Set<string>();
      if (mergedPosts.length > 0) {
        const bookmarks = await BookmarkModel.find({
          userId: viewerId,
          postId: { $in: [...postIds] },
        })
          .select('postId')
          .lean();
        for (const bookmark of bookmarks) {
          bookmarkedSet.add(String(bookmark.postId));
        }
      }

      const items = mergedPosts
        .map(({ post, source }) => {
          const id = String(post._id);
          const authorId =
            post.authorId && typeof post.authorId === 'object' && '_id' in post.authorId
              ? String((post.authorId as PopulatedAuthor)._id)
              : String(post.authorId);
          return mapPostToCalendarItem(post, source, bookmarkedSet.has(id), {
            isAuthoredByViewer: String(authorId) === viewerId,
            inCalendar: profileCalendarSet.has(id),
            hiddenOnProfile: hiddenSet.has(id),
          });
        })
        .filter((item) => item.date != null);

      return reply.send({ ok: true, data: { items } });
    },
  );
}
