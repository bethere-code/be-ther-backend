import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import type { Env } from '../../config/env.js';
import { signAdminToken } from '../../lib/jwt.js';
import { AnalyticsEventModel } from '../../models/analytics-event.model.js';
import { CalendarModel } from '../../models/calendar.model.js';
import { CommentModel } from '../../models/comment.model.js';
import { FollowModel } from '../../models/follow.model.js';
import { LikeModel } from '../../models/like.model.js';
import { PostModel } from '../../models/post.model.js';
import { PostReportModel } from '../../models/post-report.model.js';
import { UserModel } from '../../models/user.model.js';
import { UserReportModel } from '../../models/user-report.model.js';
import { parseAdminLogins } from '../../utils/admin-logins.js';
import { buildEventShareUrl } from '../../utils/share-metadata.js';

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
const USER_SELECT =
  '-passwordHash -tokenVersion -googleSub';

function parseIso(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rangeFromQuery(q: { from?: string; to?: string }): { from: Date; to: Date } | { error: string } {
  const to = parseIso(q.to) ?? new Date();
  const from = parseIso(q.from) ?? new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (from.getTime() >= to.getTime()) return { error: 'Invalid from/to' };
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) return { error: 'Range too large' };
  return { from, to };
}

function optionalCreatedRange(q: { from?: string; to?: string }): { from: Date; to: Date } | null | { error: string } {
  if (!q.from && !q.to) return null;
  const r = rangeFromQuery(q);
  if ('error' in r) return r;
  return r;
}

function pageLimit(q: { page?: string; limit?: string }): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(q.limit ?? '25', 10) || 25));
  return { page, limit, skip: (page - 1) * limit };
}

function passwordsMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type LeanUser = {
  _id: Types.ObjectId;
  eventsCount?: number;
  followersCount?: number;
  followingCount?: number;
  lastDevice?: { model?: string; platform?: string; at?: Date | string } | null;
  firstDevice?: { model?: string; platform?: string; at?: Date | string } | null;
  [key: string]: unknown;
};

/** Live counts + last-active — denormalized fields on old docs are often stale zeros. */
async function enrichAdminUsers(users: LeanUser[]): Promise<LeanUser[]> {
  if (users.length === 0) return users;
  const ids = users.map((u) => u._id);
  const [postAgg, followerAgg, followingAgg, activeAgg] = await Promise.all([
    PostModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { authorId: { $in: ids } } },
      { $group: { _id: '$authorId', n: { $sum: 1 } } },
    ]),
    FollowModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { followingId: { $in: ids } } },
      { $group: { _id: '$followingId', n: { $sum: 1 } } },
    ]),
    FollowModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { followerId: { $in: ids } } },
      { $group: { _id: '$followerId', n: { $sum: 1 } } },
    ]),
    AnalyticsEventModel.aggregate<{ _id: Types.ObjectId; at: Date }>([
      { $match: { userId: { $in: ids } } },
      { $group: { _id: '$userId', at: { $max: '$occurredAt' } } },
    ]),
  ]);
  const posts = new Map(postAgg.map((r) => [String(r._id), r.n]));
  const followers = new Map(followerAgg.map((r) => [String(r._id), r.n]));
  const following = new Map(followingAgg.map((r) => [String(r._id), r.n]));
  const lastActive = new Map(activeAgg.map((r) => [String(r._id), r.at]));

  return users.map((u) => {
    const id = String(u._id);
    const device = u.lastDevice && typeof u.lastDevice === 'object' ? { ...u.lastDevice } : null;
    const activeAt = lastActive.get(id);
    if (device && !device.at && activeAt) device.at = activeAt;
    if (!device && activeAt) {
      return {
        ...u,
        eventsCount: posts.get(id) ?? 0,
        followersCount: followers.get(id) ?? 0,
        followingCount: following.get(id) ?? 0,
        lastDevice: { model: '', platform: '', at: activeAt },
        lastActiveAt: activeAt,
      };
    }
    return {
      ...u,
      eventsCount: posts.get(id) ?? 0,
      followersCount: followers.get(id) ?? 0,
      followingCount: following.get(id) ?? 0,
      lastDevice: device,
      lastActiveAt: device?.at ?? activeAt ?? null,
    };
  });
}

export async function registerAdminV1Routes(app: FastifyInstance, env: Env): Promise<void> {
  const logins = parseAdminLogins(env.ADMIN_LOGINS);

  app.post(
    '/api/v1/admin/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (logins.size === 0) {
        return reply.status(503).send({ ok: false, error: { message: 'Admin login is not configured' } });
      }
      const parsed = z
        .object({ email: z.string().email(), password: z.string().min(1).max(200) })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }
      const email = parsed.data.email.toLowerCase().trim();
      const expected = logins.get(email);
      if (!expected || !passwordsMatch(parsed.data.password, expected)) {
        return reply.status(401).send({ ok: false, error: { message: 'Invalid credentials' } });
      }
      return reply.send({
        ok: true,
        data: { accessToken: signAdminToken(env, email), email },
      });
    },
  );

  app.get(
    '/api/v1/admin/overview',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const q = req.query as { from?: string; to?: string };
      const range = rangeFromQuery(q);
      if ('error' in range) {
        return reply.status(400).send({ ok: false, error: { message: range.error } });
      }
      const { from, to } = range;
      const created = { createdAt: { $gte: from, $lte: to } };
      const occurred = { occurredAt: { $gte: from, $lte: to } };

      const [
        usersTotal,
        usersInRange,
        postsTotal,
        postsInRange,
        followsInRange,
        commentsInRange,
        likesInRange,
        reportsInRange,
        userReportsInRange,
        screenAgg,
        authAgg,
      ] = await Promise.all([
        UserModel.countDocuments({}),
        UserModel.countDocuments(created),
        PostModel.countDocuments({}),
        PostModel.countDocuments(created),
        FollowModel.countDocuments(created),
        CommentModel.countDocuments(created),
        LikeModel.countDocuments(created),
        PostReportModel.countDocuments(created),
        UserReportModel.countDocuments(created),
        AnalyticsEventModel.aggregate<{ durationMs: number; count: number }>([
          { $match: { ...occurred, type: 'screen_time' } },
          { $group: { _id: null, durationMs: { $sum: '$durationMs' }, count: { $sum: 1 } } },
        ]),
        AnalyticsEventModel.aggregate<{ _id: string; count: number }>([
          { $match: { ...occurred, type: 'auth' } },
          { $group: { _id: '$action', count: { $sum: 1 } } },
        ]),
      ]);

      return reply.send({
        ok: true,
        data: {
          from: from.toISOString(),
          to: to.toISOString(),
          usersTotal,
          usersInRange,
          postsTotal,
          postsInRange,
          followsInRange,
          commentsInRange,
          likesInRange,
          reportsInRange: reportsInRange + userReportsInRange,
          screenTimeMs: screenAgg[0]?.durationMs ?? 0,
          screenEvents: screenAgg[0]?.count ?? 0,
          auth: Object.fromEntries(authAgg.map((a) => [a._id || 'unknown', a.count])),
        },
      });
    },
  );

  app.get(
    '/api/v1/admin/users',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const q = req.query as {
        from?: string;
        to?: string;
        q?: string;
        sort?: string;
        dir?: string;
        page?: string;
        limit?: string;
      };
      const range = optionalCreatedRange(q);
      if (range && 'error' in range) {
        return reply.status(400).send({ ok: false, error: { message: range.error } });
      }
      const { page, limit, skip } = pageLimit(q);
      const filter: Record<string, unknown> = {};
      const search = (q.q ?? '').trim().slice(0, 80);
      // Search is global — join-date range only when not searching.
      if (range && search.length < 2) filter.createdAt = { $gte: range.from, $lte: range.to };
      if (search.length >= 2) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filter.$or = [{ username: rx }, { email: rx }, { displayName: rx }];
      }
      const sortKey =
        q.sort === 'followersCount' ||
        q.sort === 'followingCount' ||
        q.sort === 'eventsCount' ||
        q.sort === 'lastDevice.at'
          ? q.sort
          : 'createdAt';
      const dir = q.dir === 'asc' ? 1 : -1;
      const [rawItems, total] = await Promise.all([
        UserModel.find(filter)
          .select(USER_SELECT)
          .sort({ [sortKey]: dir })
          .skip(skip)
          .limit(limit)
          .lean(),
        UserModel.countDocuments(filter),
      ]);
      const items = await enrichAdminUsers(rawItems as LeanUser[]);
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          page,
          limit,
          from: range ? range.from.toISOString() : null,
          to: range ? range.to.toISOString() : null,
        },
      });
    },
  );

  app.get(
    '/api/v1/admin/users/:id',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const id = String((req.params as { id: string }).id);
      if (!Types.ObjectId.isValid(id)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid id' } });
      }
      const raw = await UserModel.findById(id).select('-passwordHash').lean();
      if (!raw) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      const [enriched] = await enrichAdminUsers([raw as LeanUser]);
      return reply.send({
        ok: true,
        data: { user: enriched },
      });
    },
  );

  app.get(
    '/api/v1/admin/posts',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const q = req.query as {
        from?: string;
        to?: string;
        dir?: string;
        sort?: string;
        page?: string;
        limit?: string;
        authorId?: string;
      };
      const authorOk = Boolean(q.authorId && Types.ObjectId.isValid(q.authorId));
      const range = optionalCreatedRange(q);
      if (range && 'error' in range) {
        return reply.status(400).send({ ok: false, error: { message: range.error } });
      }
      const { page, limit, skip } = pageLimit(q);
      const filter: Record<string, unknown> = {};
      if (range) filter.createdAt = { $gte: range.from, $lte: range.to };
      if (authorOk) filter.authorId = new Types.ObjectId(q.authorId!);
      const sortKey = q.sort === 'likesCount' ? 'likesCount' : 'createdAt';
      const dir = q.dir === 'asc' ? 1 : -1;
      const [items, total] = await Promise.all([
        PostModel.find(filter)
          .sort({ [sortKey]: dir })
          .skip(skip)
          .limit(limit)
          .populate('authorId', 'username displayName avatarUrl')
          .lean(),
        PostModel.countDocuments(filter),
      ]);
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          page,
          limit,
          from: range ? range.from.toISOString() : null,
          to: range ? range.to.toISOString() : null,
        },
      });
    },
  );

  app.get(
    '/api/v1/admin/posts/:id',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const id = String((req.params as { id: string }).id);
      if (!Types.ObjectId.isValid(id)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid id' } });
      }
      const oid = new Types.ObjectId(id);
      const post = await PostModel.findById(oid)
        .populate('authorId', 'username displayName avatarUrl email')
        .lean();
      if (!post) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }
      const [likesCount, interestedCount, goingOnly, legacyGoing] = await Promise.all([
        LikeModel.countDocuments({ postId: oid }),
        CalendarModel.countDocuments({ postId: oid, status: 'interested' }),
        CalendarModel.countDocuments({ postId: oid, status: 'going' }),
        CalendarModel.countDocuments({
          postId: oid,
          status: { $nin: ['interested', 'going'] },
        }),
      ]);
      return reply.send({
        ok: true,
        data: {
          post,
          likesCount,
          interestedCount,
          goingCount: goingOnly + legacyGoing,
          shareUrl: buildEventShareUrl(env, id),
        },
      });
    },
  );

  app.get(
    '/api/v1/admin/posts/:id/people',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const id = String((req.params as { id: string }).id);
      const kind = String((req.query as { kind?: string }).kind ?? '');
      if (!Types.ObjectId.isValid(id)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid id' } });
      }
      if (kind !== 'likes' && kind !== 'interested' && kind !== 'going') {
        return reply.status(400).send({ ok: false, error: { message: 'kind must be likes, interested, or going' } });
      }
      const oid = new Types.ObjectId(id);
      const exists = await PostModel.exists({ _id: oid });
      if (!exists) {
        return reply.status(404).send({ ok: false, error: { message: 'Post not found' } });
      }

      type Person = {
        _id: string;
        username: string;
        displayName: string;
        avatarUrl: string;
        at: string | null;
      };

      const mapUser = (
        raw: { _id?: Types.ObjectId; username?: string; displayName?: string; avatarUrl?: string } | null | undefined,
        at: Date | undefined,
      ): Person | null => {
        if (!raw?._id) return null;
        const username = String(raw.username ?? '').trim();
        if (!username) return null;
        return {
          _id: String(raw._id),
          username,
          displayName: String(raw.displayName ?? '').trim() || username,
          avatarUrl: String(raw.avatarUrl ?? ''),
          at: at ? at.toISOString() : null,
        };
      };

      if (kind === 'likes') {
        const rows = await LikeModel.find({ postId: oid })
          .sort({ createdAt: -1 })
          .limit(200)
          .populate('userId', 'username displayName avatarUrl')
          .lean();
        const items = rows
          .map((row) =>
            mapUser(
              row.userId as {
                _id?: Types.ObjectId;
                username?: string;
                displayName?: string;
                avatarUrl?: string;
              },
              row.createdAt,
            ),
          )
          .filter(Boolean);
        return reply.send({ ok: true, data: { kind, items } });
      }

      const calFilter: Record<string, unknown> =
        kind === 'interested'
          ? { postId: oid, status: 'interested' }
          : {
              postId: oid,
              $or: [{ status: 'going' }, { status: { $exists: false } }, { status: null }],
            };
      const rows = await CalendarModel.find(calFilter)
        .sort({ createdAt: -1 })
        .limit(200)
        .populate('userId', 'username displayName avatarUrl')
        .lean();
      const items = rows
        .map((row) =>
          mapUser(
            row.userId as {
              _id?: Types.ObjectId;
              username?: string;
              displayName?: string;
              avatarUrl?: string;
            },
            row.createdAt,
          ),
        )
        .filter(Boolean);
      return reply.send({ ok: true, data: { kind, items } });
    },
  );

  app.get(
    '/api/v1/admin/analytics/events',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const q = req.query as {
        from?: string;
        to?: string;
        type?: string;
        userId?: string;
        sort?: string;
        dir?: string;
        page?: string;
        limit?: string;
      };
      const userIdOk = Boolean(q.userId && Types.ObjectId.isValid(q.userId));
      // Per-user activity: date range optional. Global analytics: last-7-days default required.
      const range = userIdOk ? optionalCreatedRange(q) : rangeFromQuery(q);
      if (range && 'error' in range) {
        return reply.status(400).send({ ok: false, error: { message: range.error } });
      }
      // Analytics UI groups events into sessions client-side; allow a larger page.
      const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
      const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit ?? '25', 10) || 25));
      const skip = (page - 1) * limit;
      const filter: Record<string, unknown> = {};
      if (range) filter.occurredAt = { $gte: range.from, $lte: range.to };
      if (q.type === 'screen_time' || q.type === 'auth') filter.type = q.type;
      if (userIdOk) filter.userId = new Types.ObjectId(q.userId!);
      const sortKey = q.sort === 'durationMs' ? 'durationMs' : 'occurredAt';
      const dir = q.dir === 'asc' ? 1 : -1;
      const [items, total] = await Promise.all([
        AnalyticsEventModel.find(filter)
          .sort({ [sortKey]: dir })
          .skip(skip)
          .limit(limit)
          .populate('userId', 'username displayName avatarUrl')
          .lean(),
        AnalyticsEventModel.countDocuments(filter),
      ]);
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          page,
          limit,
          from: range ? range.from.toISOString() : null,
          to: range ? range.to.toISOString() : null,
        },
      });
    },
  );

  app.get(
    '/api/v1/admin/reports',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const q = req.query as { from?: string; to?: string; dir?: string; page?: string; limit?: string };
      const range = optionalCreatedRange(q);
      if (range && 'error' in range) {
        return reply.status(400).send({ ok: false, error: { message: range.error } });
      }
      const { page, limit, skip } = pageLimit(q);
      const filter: Record<string, unknown> = {};
      if (range) filter.createdAt = { $gte: range.from, $lte: range.to };
      const dir = q.dir === 'asc' ? 1 : -1;
      const [items, total] = await Promise.all([
        PostReportModel.find(filter)
          .sort({ createdAt: dir })
          .skip(skip)
          .limit(limit)
          .populate('reporterId', 'username email')
          .populate('postId', 'caption location imageUrl')
          .lean(),
        PostReportModel.countDocuments(filter),
      ]);
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          page,
          limit,
          from: range ? range.from.toISOString() : null,
          to: range ? range.to.toISOString() : null,
        },
      });
    },
  );

  app.get(
    '/api/v1/admin/user-reports',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const q = req.query as { from?: string; to?: string; dir?: string; page?: string; limit?: string };
      const range = optionalCreatedRange(q);
      if (range && 'error' in range) {
        return reply.status(400).send({ ok: false, error: { message: range.error } });
      }
      const { page, limit, skip } = pageLimit(q);
      const filter: Record<string, unknown> = {};
      if (range) filter.createdAt = { $gte: range.from, $lte: range.to };
      const dir = q.dir === 'asc' ? 1 : -1;
      const [items, total] = await Promise.all([
        UserReportModel.find(filter)
          .sort({ createdAt: dir })
          .skip(skip)
          .limit(limit)
          .populate('reporterId', 'username email')
          .populate('reportedUserId', 'username email displayName')
          .lean(),
        UserReportModel.countDocuments(filter),
      ]);
      return reply.send({
        ok: true,
        data: {
          items,
          total,
          page,
          limit,
          from: range ? range.from.toISOString() : null,
          to: range ? range.to.toISOString() : null,
        },
      });
    },
  );
}
