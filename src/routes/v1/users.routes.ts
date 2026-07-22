import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { CalendarModel } from '../../models/calendar.model.js';
import { NotificationModel } from '../../models/notification.model.js';
import { PostModel } from '../../models/post.model.js';
import { ProfileCalendarHiddenModel } from '../../models/profile-calendar-hidden.model.js';
import { ProfileStarModel } from '../../models/profile-star.model.js';
import { UserModel } from '../../models/user.model.js';
import { computeMemberBadge, formatJoinedDate, parseEventDateToIso } from '../../utils/event-date.js';

type PopulatedAuthor = {
  _id: Types.ObjectId;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  starsReceived?: number;
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
    const stars = Number(authorId.starsReceived ?? 0);
    return {
      _id: String(authorId._id),
      username: authorId.username ?? '',
      displayName: authorId.displayName ?? authorId.username ?? '',
      avatarUrl: authorId.avatarUrl ?? '',
      badge: computeMemberBadge(stars),
    };
  }
  if (authorId) {
    return { _id: String(authorId), username: '', displayName: '', avatarUrl: '' };
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

async function enrichUserForViewer(
  user: Record<string, unknown>,
  viewerId: string | undefined,
): Promise<Record<string, unknown>> {
  const userId = String(user._id);
  const isOwnProfile = viewerId != null && userId === viewerId;
  let isStarredByMe = false;
  let canDM = false;

  if (!isOwnProfile && viewerId) {
    isStarredByMe = Boolean(
      await ProfileStarModel.exists({ fromUserId: viewerId, toUserId: userId }),
    );
    if (isStarredByMe) {
      canDM = Boolean(
        await ProfileStarModel.exists({ fromUserId: userId, toUserId: viewerId }),
      );
    }
  }

  // Live counts: events created, followers (starred me), following (I starred).
  const [eventsCount, followersCount, followingCount] = await Promise.all([
    PostModel.countDocuments({ authorId: userId }),
    ProfileStarModel.countDocuments({ toUserId: userId }),
    ProfileStarModel.countDocuments({ fromUserId: userId }),
  ]);

  const starsReceived = Number(user.starsReceived ?? 0);
  const payload: Record<string, unknown> = {
    ...user,
    isOwnProfile,
    isStarredByMe,
    canDM,
    eventsCount,
    followersCount,
    followingCount,
    badge: computeMemberBadge(starsReceived),
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
      const starred = await ProfileStarModel.exists({ fromUserId: req.userId, toUserId: user._id });
      if (!starred) {
        return reply.status(403).send({ ok: false, error: { message: 'Private profile' } });
      }
    }
    const data = await enrichUserForViewer(user as Record<string, unknown>, req.userId);
    return reply.send({ ok: true, data });
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
        const followersCount = await ProfileStarModel.countDocuments({ toUserId: to });
        return reply.send({
          ok: true,
          data: { starred: false, followersCount },
        });
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
      const followersCount = await ProfileStarModel.countDocuments({ toUserId: to });
      return reply.send({
        ok: true,
        data: { starred: true, followersCount },
      });
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
        const starred = await ProfileStarModel.exists({ fromUserId: viewerId, toUserId: user._id });
        if (!starred) {
          return reply.status(403).send({ ok: false, error: { message: 'Private profile' } });
        }
      }

      const authored = await PostModel.find({ authorId: user._id })
        .select('authorId location status imageUrl createdAt eventDetails country isPrivate')
        .populate('authorId', 'username displayName avatarUrl starsReceived')
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
            .populate('authorId', 'username displayName avatarUrl starsReceived')
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
