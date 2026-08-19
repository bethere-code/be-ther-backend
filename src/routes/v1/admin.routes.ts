import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import type { Env } from '../../config/env.js';
import { signAdminToken } from '../../lib/jwt.js';
import { AnalyticsEventModel } from '../../models/analytics-event.model.js';
import { CommentModel } from '../../models/comment.model.js';
import { FollowModel } from '../../models/follow.model.js';
import { LikeModel } from '../../models/like.model.js';
import { PostModel } from '../../models/post.model.js';
import { PostReportModel } from '../../models/post-report.model.js';
import { UserModel } from '../../models/user.model.js';
import { parseAdminLogins } from '../../utils/admin-logins.js';

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
          reportsInRange,
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
      if (range) filter.createdAt = { $gte: range.from, $lte: range.to };
      const search = (q.q ?? '').trim().slice(0, 80);
      if (search.length >= 2) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filter.$or = [{ username: rx }, { email: rx }, { displayName: rx }];
      }
      const sortKey =
        q.sort === 'followersCount' || q.sort === 'eventsCount' || q.sort === 'lastDevice.at'
          ? q.sort
          : 'createdAt';
      const dir = q.dir === 'asc' ? 1 : -1;
      const [items, total] = await Promise.all([
        UserModel.find(filter)
          .select(USER_SELECT)
          .sort({ [sortKey]: dir })
          .skip(skip)
          .limit(limit)
          .lean(),
        UserModel.countDocuments(filter),
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
    '/api/v1/admin/users/:id',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const id = String((req.params as { id: string }).id);
      if (!Types.ObjectId.isValid(id)) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid id' } });
      }
      const user = await UserModel.findById(id).select('-passwordHash').lean();
      if (!user) {
        return reply.status(404).send({ ok: false, error: { message: 'User not found' } });
      }
      const oid = new Types.ObjectId(id);
      const [posts, events] = await Promise.all([
        PostModel.find({ authorId: oid }).sort({ createdAt: -1 }).limit(20).lean(),
        AnalyticsEventModel.find({ userId: oid }).sort({ occurredAt: -1 }).limit(50).lean(),
      ]);
      return reply.send({ ok: true, data: { user, posts, events } });
    },
  );

  app.get(
    '/api/v1/admin/posts',
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
        PostModel.find(filter)
          .sort({ createdAt: dir })
          .skip(skip)
          .limit(limit)
          .populate('authorId', 'username displayName email')
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
    '/api/v1/admin/analytics/events',
    { preHandler: [app.authenticateAdmin] },
    async (req, reply) => {
      const q = req.query as {
        from?: string;
        to?: string;
        type?: string;
        userId?: string;
        dir?: string;
        page?: string;
        limit?: string;
      };
      const range = rangeFromQuery(q);
      if ('error' in range) {
        return reply.status(400).send({ ok: false, error: { message: range.error } });
      }
      const { page, limit, skip } = pageLimit(q);
      const filter: Record<string, unknown> = {
        occurredAt: { $gte: range.from, $lte: range.to },
      };
      if (q.type === 'screen_time' || q.type === 'auth') filter.type = q.type;
      if (q.userId && Types.ObjectId.isValid(q.userId)) {
        filter.userId = new Types.ObjectId(q.userId);
      }
      const dir = q.dir === 'asc' ? 1 : -1;
      const [items, total] = await Promise.all([
        AnalyticsEventModel.find(filter).sort({ occurredAt: dir }).skip(skip).limit(limit).lean(),
        AnalyticsEventModel.countDocuments(filter),
      ]);
      return reply.send({
        ok: true,
        data: { items, total, page, limit, from: range.from.toISOString(), to: range.to.toISOString() },
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
}
