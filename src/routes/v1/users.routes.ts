import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import { BookmarkModel } from '../../models/bookmark.model.js';
import { BlockModel } from '../../models/block.model.js';
import { CalendarModel } from '../../models/calendar.model.js';
import { FollowModel, acceptedOnly } from '../../models/follow.model.js';
import { PostModel } from '../../models/post.model.js';
import { ProfileCalendarHiddenModel } from '../../models/profile-calendar-hidden.model.js';
import { UserModel } from '../../models/user.model.js';
import { USER_REPORT_REASONS, UserReportModel } from '../../models/user-report.model.js';
import { deleteFollowEdge, followPair, hasPendingFollowRequest, isBlockedEitherWay, isFollowing, respondFollowRequest, setBlock, toggleFollow } from '../../services/follow.service.js';
import { formatJoinedDate, parseEventDateToIso } from '../../utils/event-date.js';
import { enrichPostsForViewer } from '../../utils/enrich-posts.js';
import { USERNAME_CHANGE_REGEX, usernameChangeLocked } from '../../utils/username-change.js';

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
  caption?: string;
  isPrivate?: boolean;
  calendarCount?: number;
  viewCount?: number;
  likesCount?: number;
  commentsCount?: number;
  eventDetails?: {
    date?: string;
    time?: string;
    venue?: string;
    ticketUrl?: string;
    eventLocation?: {
      name?: string;
      formattedAddress?: string;
      locality?: string;
      city?: string;
      state?: string;
      country?: string;
    };
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
    calendarStatus?: 'interested' | 'going' | null;
  },
) {
  const date =
    parseEventDateToIso(post.eventDetails?.date) ??
    (post.createdAt ? new Date(post.createdAt).toISOString().slice(0, 10) : null);

  const country = String(
    post.eventDetails?.eventLocation?.country ?? post.country ?? '',
  ).trim();
  const venue = String(post.eventDetails?.venue ?? '').trim();
  const location = String(post.location ?? '').trim();
  const eventLocation = post.eventDetails?.eventLocation;
  const formattedAddress = String(eventLocation?.formattedAddress ?? '').trim();
  const placeName = String(eventLocation?.name ?? '').trim();
  let place = formattedAddress || country;
  if (!place && venue && venue.toLowerCase() !== location.toLowerCase()) {
    place = venue;
  } else if (!place) {
    place = venue;
  }

  const addressParts = [
    formattedAddress,
    [placeName, eventLocation?.city, eventLocation?.state, eventLocation?.country]
      .map((p) => String(p ?? '').trim())
      .filter(Boolean)
      .join(', '),
    venue,
    place,
  ];
  let address = '';
  for (const part of addressParts) {
    if (part && part.toLowerCase() !== location.toLowerCase()) {
      address = part;
      break;
    }
  }
  if (!address) {
    address = formattedAddress || venue || place || location;
  }

  return {
    postId: String(post._id),
    date,
    location,
    title: location,
    imageUrl: post.imageUrl,
    caption: String(post.caption ?? '').trim() || null,
    status: post.status,
    venue,
    country,
    place: place || null,
    address: address || null,
    calendarCount: Math.max(0, Number(post.calendarCount ?? 0) || 0),
    viewCount: Math.max(0, Number(post.viewCount ?? 0) || 0),
    likesCount: Math.max(0, Number(post.likesCount ?? 0) || 0),
    commentsCount: Math.max(0, Number(post.commentsCount ?? 0) || 0),
    ticketUrl: post.eventDetails?.ticketUrl ?? null,
    time: post.eventDetails?.time ?? null,
    source,
    bookmarked,
    isAuthoredByMe: extras?.isAuthoredByViewer ?? false,
    inCalendar: extras?.inCalendar ?? false,
    // Always the authenticated viewer's RSVP — never the profile owner's.
    calendarStatus: extras?.calendarStatus ?? null,
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
  let theyFollowMe = false;
  let canDM = false;
  let isBlocked = false;

  if (!isOwnProfile && viewerId) {
    const pair = await followPair(viewerId, userId);
    viewerFollows = pair.aFollowsB;
    theyFollowMe = pair.bFollowsA;
    canDM = pair.aFollowsB && pair.bFollowsA;
    isBlocked = Boolean(
      await BlockModel.exists({
        blockerId: new Types.ObjectId(viewerId),
        blockedId: new Types.ObjectId(userId),
      }),
    );
  }

  const followRequestPending =
    !isOwnProfile && viewerId && !viewerFollows
      ? await hasPendingFollowRequest(viewerId, userId)
      : false;

  // Prefer denormalized counters (O(1)). Fall back only if fields are missing on old docs.
  let eventsCount = user.eventsCount;
  let followersCount = user.followersCount;
  let followingCount = user.followingCount;
  if (eventsCount == null || followersCount == null || followingCount == null) {
    const [events, followers, following] = await Promise.all([
      eventsCount == null ? PostModel.countDocuments({ authorId: userId }) : Promise.resolve(null),
      followersCount == null
        ? FollowModel.countDocuments(acceptedOnly({ followingId: userId }))
        : Promise.resolve(null),
      followingCount == null
        ? FollowModel.countDocuments(acceptedOnly({ followerId: userId }))
        : Promise.resolve(null),
    ]);
    if (events != null) eventsCount = events;
    if (followers != null) followersCount = followers;
    if (following != null) followingCount = following;
  }

  const rawSettings =
    user.settings && typeof user.settings === 'object'
      ? (user.settings as Record<string, unknown>)
      : {};
  const calendarView =
    rawSettings.calendarView === 'events-only' ? 'events-only' : 'full';

  const payload: Record<string, unknown> = {
    ...user,
    settings: {
      isPrivateProfile: Boolean(rawSettings.isPrivateProfile),
      pushEnabled:
        rawSettings.pushEnabled === undefined
          ? true
          : Boolean(rawSettings.pushEnabled),
      calendarView,
    },
    isOwnProfile,
    isFollowing: viewerFollows,
    followRequestPending,
    isFollowedBy: theyFollowMe,
    isBlocked,
    isMutualFollow: canDM,
    canDM,
    usernameChangedAt: isOwnProfile && user.usernameChangedAt
      ? new Date(user.usernameChangedAt as Date | string).toISOString()
      : null,
    eventsCount: clampCount(eventsCount),
    followersCount: clampCount(followersCount),
    followingCount: clampCount(followingCount),
    // badge: paused — restore when multi-signal badge logic lands
    badge: null,
    joined: formatJoinedDate(user.createdAt as Date | string | undefined),
  };
  delete payload.devicePermissions;
  delete payload.firstDevice;
  delete payload.lastDevice;
  delete payload.fcmToken;
  delete payload.passwordHash;
  return payload;
}

const patchUserSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  bio: z.string().max(200).optional(),
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

  app.get(
    '/api/v1/users/me/blocks',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const rows = await BlockModel.find({ blockerId: req.userId })
        .sort({ createdAt: -1 })
        .populate('blockedId', 'username displayName avatarUrl')
        .lean();
      const items = rows
        .map((row) => {
          const raw = row.blockedId;
          if (!raw || typeof raw !== 'object') return null;
          const u = raw as {
            _id?: Types.ObjectId;
            username?: string;
            displayName?: string;
            avatarUrl?: string;
          };
          const username = String(u.username ?? '').trim();
          if (!username) return null;
          return {
            _id: u._id != null ? String(u._id) : '',
            username,
            displayName: String(u.displayName ?? '').trim() || username,
            avatarUrl: String(u.avatarUrl ?? ''),
          };
        })
        .filter(Boolean);
      return reply.send({ ok: true, data: { items } });
    },
  );

  app.get(
    '/api/v1/users/me/username/available',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const raw = String((req.query as { q?: string }).q ?? '')
        .trim()
        .toLowerCase();
      if (!USERNAME_CHANGE_REGEX.test(raw)) {
        return reply.send({
          ok: true,
          data: {
            available: false,
            reason: 'Use 3–20 lowercase letters and digits',
          },
        });
      }
      const me = await UserModel.findById(req.userId).select('username').lean();
      if (!me) {
        return reply.status(401).send({ ok: false, error: { message: 'Invalid token user' } });
      }
      if (me.username === raw) {
        return reply.send({ ok: true, data: { available: true, own: true } });
      }
      const taken = await UserModel.exists({ username: raw });
      return reply.send({
        ok: true,
        data: taken
          ? { available: false, reason: 'Username already exists' }
          : { available: true },
      });
    },
  );

  app.patch(
    '/api/v1/users/me/username',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = z
        .object({ username: z.string().trim().toLowerCase() })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const next = parsed.data.username;
      if (!USERNAME_CHANGE_REGEX.test(next)) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'Use 3–20 lowercase letters and digits' },
        });
      }
      const user = await UserModel.findById(req.userId);
      if (!user) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      if (user.username === next) {
        const data = await enrichUserForViewer(user.toObject() as Record<string, unknown>, req.userId);
        return reply.send({ ok: true, data });
      }
      if (usernameChangeLocked(user.usernameChangedAt)) {
        return reply.status(403).send({
          ok: false,
          error: { message: 'You cannot edit your username for 7 days after the last change' },
        });
      }
      const taken = await UserModel.exists({ username: next });
      if (taken) {
        return reply.status(409).send({
          ok: false,
          error: { message: 'Username already exists' },
        });
      }
      user.username = next;
      user.usernameChangedAt = new Date();
      try {
        await user.save();
      } catch (err: unknown) {
        const code = (err as { code?: number })?.code;
        if (code === 11000) {
          return reply.status(409).send({
            ok: false,
            error: { message: 'Username already exists' },
          });
        }
        throw err;
      }
      const data = await enrichUserForViewer(user.toObject() as Record<string, unknown>, req.userId);
      return reply.send({ ok: true, data });
    },
  );

  app.get('/api/v1/users/:username', { preHandler: [app.authenticate] }, async (req, reply) => {
    const username = String((req.params as { username: string }).username).toLowerCase();
    const user = await UserModel.findOne({ username }).lean();
    if (!user) {
      return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
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
            requested: result.requested,
            followersCount: result.followersCount,
          },
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'CANNOT_FOLLOW_SELF') {
          return reply.status(400).send({ ok: false, error: { message: 'Cannot follow yourself' } });
        }
        if (err instanceof Error && err.message === 'BLOCKED') {
          return reply.status(403).send({ ok: false, error: { message: 'You cannot follow this account' } });
        }
        if (err instanceof Error && err.message === 'USER_NOT_FOUND') {
          return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/users/:username/follow-request',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const parsed = z
        .object({ action: z.enum(['accept', 'reject']) })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: { message: 'action must be accept or reject' } });
      }
      const requester = await UserModel.findOne({ username }).select('_id').lean();
      if (!requester) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      try {
        const result = await respondFollowRequest(
          req.userId!,
          String(requester._id),
          parsed.data.action,
        );
        return reply.send({
          ok: true,
          data: {
            accepted: result.accepted,
            followersCount: result.followersCount,
          },
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'NO_PENDING_REQUEST') {
          return reply
            .status(400)
            .send({ ok: false, error: { message: 'No pending follow request from this user' } });
        }
        if (err instanceof Error && err.message === 'CANNOT_FOLLOW_SELF') {
          return reply.status(400).send({ ok: false, error: { message: 'Invalid request' } });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/users/:username/remove-follower',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const target = await UserModel.findOne({ username }).select('_id').lean();
      if (!target) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      const me = req.userId!;
      const them = String(target._id);
      if (me === them) {
        return reply.status(400).send({ ok: false, error: { message: 'Cannot remove yourself' } });
      }
      const removed = await deleteFollowEdge(them, me);
      if (!removed) {
        return reply.status(400).send({ ok: false, error: { message: 'This person is not following you' } });
      }
      return reply.send({ ok: true, data: { removed: true } });
    },
  );

  app.post(
    '/api/v1/users/:username/block',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const parsed = z.object({ blocked: z.boolean() }).safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const target = await UserModel.findOne({ username }).select('_id').lean();
      if (!target) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      try {
        const result = await setBlock(req.userId!, String(target._id), parsed.data.blocked);
        return reply.send({ ok: true, data: result });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'CANNOT_BLOCK_SELF') {
          return reply.status(400).send({ ok: false, error: { message: 'Cannot block yourself' } });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/users/:username/reports',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const parsed = z
        .object({
          reason: z.enum(USER_REPORT_REASONS),
          details: z.string().trim().max(500).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const details = parsed.data.details ?? '';
      if (parsed.data.reason === 'other' && details.length < 3) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'Please describe the issue (at least 3 characters)' },
        });
      }
      const target = await UserModel.findOne({ username }).select('_id').lean();
      if (!target) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      const reporterId = req.userId!;
      const reportedUserId = String(target._id);
      if (reporterId === reportedUserId) {
        return reply.status(400).send({ ok: false, error: { message: 'Cannot report yourself' } });
      }
      try {
        await UserReportModel.create({
          reporterId,
          reportedUserId,
          reason: parsed.data.reason,
          details,
        });
      } catch (err: unknown) {
        const code = (err as { code?: number })?.code;
        if (code === 11000) {
          return reply.status(409).send({
            ok: false,
            error: { message: 'You already reported this account' },
          });
        }
        throw err;
      }
      return reply.send({ ok: true, data: { reported: true } });
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

      if (!isOwnProfile && (await isBlockedEitherWay(viewerId, String(user._id)))) {
        return reply.send({ ok: true, data: { items: [], private: true } });
      }

      if (user.settings?.isPrivateProfile && !isOwnProfile) {
        const follows = await isFollowing(viewerId, String(user._id));
        if (!follows) {
          return reply.send({ ok: true, data: { items: [], private: true } });
        }
      }

      const authoredFilter: Record<string, unknown> = { authorId: user._id };
      if (!isOwnProfile) authoredFilter.isPrivate = false;

      const CALENDAR_POST_SELECT =
        'authorId location status imageUrl caption createdAt eventDetails country isPrivate calendarCount viewCount likesCount commentsCount';

      const [authoredRaw, hiddenOnProfile, profileCalendar, owner] = await Promise.all([
        PostModel.find(authoredFilter)
          .select(CALENDAR_POST_SELECT)
          .sort({ createdAt: -1 })
          .lean(),
        ProfileCalendarHiddenModel.find({ profileUserId: user._id }).select('postId').lean(),
        isOwnProfile
          ? CalendarModel.find({ userId: user._id }).select('postId status').lean()
          : Promise.resolve([] as Array<{ postId: Types.ObjectId; status?: string }>),
        UserModel.findById(user._id).select('_id username displayName avatarUrl').lean(),
      ]);

      const ownerAuthor: PopulatedAuthor = {
        _id: user._id as Types.ObjectId,
        username: owner?.username ?? '',
        displayName: owner?.displayName ?? owner?.username ?? '',
        avatarUrl: owner?.avatarUrl ?? '',
      };
      const authored = authoredRaw.map((post) => ({
        ...post,
        authorId: ownerAuthor,
      }));

      const hiddenSet = new Set(hiddenOnProfile.map((h) => String(h.postId)));

      const postIds = new Set<string>();
      const mergedPosts: Array<{ post: LeanPost; source: 'authored' | 'calendar' }> = [];

      for (const post of authored) {
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
            .select(CALENDAR_POST_SELECT)
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
      // Viewer RSVP only — never the profile owner's calendar status.
      const viewerCalendarStatus = new Map<string, 'interested' | 'going'>();
      if (mergedPosts.length > 0) {
        const objectIds = [...postIds]
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id));
        const [bookmarks, viewerCalendar] = await Promise.all([
          BookmarkModel.find({
            userId: viewerId,
            postId: { $in: objectIds },
          })
            .select('postId')
            .lean(),
          isOwnProfile
            ? Promise.resolve(profileCalendar)
            : CalendarModel.find({
                userId: viewerId,
                postId: { $in: objectIds },
              })
                .select('postId status')
                .lean(),
        ]);
        for (const bookmark of bookmarks) {
          bookmarkedSet.add(String(bookmark.postId));
        }
        for (const entry of viewerCalendar) {
          viewerCalendarStatus.set(
            String(entry.postId),
            entry.status === 'interested' ? 'interested' : 'going',
          );
        }
      }

      const items = mergedPosts
        .map(({ post, source }) => {
          const id = String(post._id);
          const authorId =
            post.authorId && typeof post.authorId === 'object' && '_id' in post.authorId
              ? String((post.authorId as PopulatedAuthor)._id)
              : String(post.authorId);
          const isAuthoredByViewer = String(authorId) === viewerId;
          const fromViewer = viewerCalendarStatus.get(id) ?? null;
          // Authors are always on their own calendar; everyone else uses their row only.
          const calendarStatus: 'interested' | 'going' | null = isAuthoredByViewer
            ? (fromViewer ??
                (post.status === 'interested' ? 'interested' : 'going'))
            : fromViewer;
          return mapPostToCalendarItem(post, source, bookmarkedSet.has(id), {
            isAuthoredByViewer,
            inCalendar: calendarStatus != null,
            hiddenOnProfile: hiddenSet.has(id),
            calendarStatus,
          });
        })
        .filter((item) => item.date != null);

      return reply.send({ ok: true, data: { items } });
    },
  );

  async function loadPublicProfileUser(username: string, viewerId: string) {
    const user = await UserModel.findOne({ username }).select('_id settings').lean();
    if (!user) return { error: 'not_found' as const };
    const isOwn = String(user._id) === viewerId;
    if (!isOwn && (await isBlockedEitherWay(viewerId, String(user._id)))) {
      return { error: 'private' as const };
    }
    if (user.settings?.isPrivateProfile && !isOwn) {
      const follows = await isFollowing(viewerId, String(user._id));
      if (!follows) return { error: 'private' as const };
    }
    return { user, isOwn };
  }

  function mapConnectionUser(raw: unknown) {
    if (!raw || typeof raw !== 'object') return null;
    const u = raw as {
      _id?: Types.ObjectId;
      username?: string;
      displayName?: string;
      avatarUrl?: string;
    };
    const username = String(u.username ?? '').trim();
    if (!username) return null;
    return {
      _id: u._id != null ? String(u._id) : '',
      username,
      displayName: String(u.displayName ?? '').trim() || username,
      avatarUrl: String(u.avatarUrl ?? ''),
    };
  }

  app.get(
    '/api/v1/users/:username/events',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const viewerId = req.userId!;
      const loaded = await loadPublicProfileUser(username, viewerId);
      if ('error' in loaded) {
        if (loaded.error === 'not_found') {
          return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
        }
        return reply.send({ ok: true, data: { items: [], private: true } });
      }

      const postsFilter: Record<string, unknown> = { authorId: loaded.user._id };
      if (!loaded.isOwn) postsFilter.isPrivate = false;

      const [postsRaw, owner] = await Promise.all([
        PostModel.find(postsFilter).sort({ createdAt: -1 }).lean(),
        UserModel.findById(loaded.user._id).select('_id username displayName avatarUrl').lean(),
      ]);
      const ownerAuthor = {
        _id: loaded.user._id,
        username: owner?.username ?? '',
        displayName: owner?.displayName ?? owner?.username ?? '',
        avatarUrl: owner?.avatarUrl ?? '',
      };
      const posts = postsRaw.map((post) => ({ ...post, authorId: ownerAuthor }));
      const enriched = await enrichPostsForViewer(posts as never[], viewerId);
      return reply.send({ ok: true, data: { items: enriched } });
    },
  );

  app.get(
    '/api/v1/users/:username/followers',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const viewerId = req.userId!;
      const loaded = await loadPublicProfileUser(username, viewerId);
      if ('error' in loaded) {
        if (loaded.error === 'not_found') {
          return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
        }
        return reply.send({ ok: true, data: { items: [], private: true } });
      }

      const edges = await FollowModel.find(
        acceptedOnly({ followingId: loaded.user._id }),
      )
        .sort({ createdAt: -1 })
        .limit(200)
        .populate('followerId', 'username displayName avatarUrl')
        .lean();

      const items = edges
        .map((e) => mapConnectionUser(e.followerId))
        .filter((u): u is NonNullable<typeof u> => u != null);

      return reply.send({ ok: true, data: { items } });
    },
  );

  app.get(
    '/api/v1/users/:username/following',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const username = String((req.params as { username: string }).username).toLowerCase();
      const viewerId = req.userId!;
      const loaded = await loadPublicProfileUser(username, viewerId);
      if ('error' in loaded) {
        if (loaded.error === 'not_found') {
          return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
        }
        return reply.send({ ok: true, data: { items: [], private: true } });
      }

      const edges = await FollowModel.find(
        acceptedOnly({ followerId: loaded.user._id }),
      )
        .sort({ createdAt: -1 })
        .limit(200)
        .populate('followingId', 'username displayName avatarUrl')
        .lean();

      const items = edges
        .map((e) => mapConnectionUser(e.followingId))
        .filter((u): u is NonNullable<typeof u> => u != null);

      return reply.send({ ok: true, data: { items } });
    },
  );
}
