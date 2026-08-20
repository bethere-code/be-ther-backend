import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';

import { AnalyticsEventModel } from '../../models/analytics-event.model.js';
import { UserModel } from '../../models/user.model.js';
import { applyDeviceSnapshot, normalizeDeviceInput } from '../../utils/device-snapshot.js';

const MAX_BATCH = 50;
const MAX_DURATION_MS = 30 * 60 * 1000;
const SKIP_SCREENS = new Set(['splash']);

const deviceSchema = z
  .object({
    platform: z.string().trim().max(32).optional(),
    model: z.string().trim().max(80).optional(),
    os: z.string().trim().max(40).optional(),
    appVersion: z.string().trim().max(32).optional(),
    appBuild: z.string().trim().max(16).optional(),
    deviceId: z.string().trim().max(128).optional(),
  })
  .optional();

const screenEventSchema = z.object({
  eventId: z.string().trim().min(8).max(80),
  type: z.literal('screen_time'),
  screen: z.string().trim().min(1).max(80),
  path: z.string().trim().max(200).optional(),
  enteredAt: z.string().datetime(),
  exitedAt: z.string().datetime(),
  durationMs: z.number().int().min(0).max(MAX_DURATION_MS),
  exitReason: z.string().trim().max(32).optional(),
});

const authEventSchema = z.object({
  eventId: z.string().trim().min(8).max(80),
  type: z.literal('auth'),
  action: z.enum(['signup', 'login', 'logout']),
  at: z.string().datetime(),
  device: deviceSchema,
});

const batchSchema = z.object({
  sentAt: z.string().datetime().optional(),
  trigger: z.enum(['periodic', 'background', 'launch', 'logout', 'manual']).optional(),
  app: z
    .object({
      version: z.string().trim().max(32),
      build: z.string().trim().max(16),
      platform: z.string().trim().max(32).optional(),
    })
    .optional(),
  events: z.array(z.unknown()).min(1).max(MAX_BATCH),
});

function parseIso(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function registerAnalyticsV1Routes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/analytics/events',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      }

      const userId = req.userId!;
      const acknowledgedEventIds: string[] = [];
      const duplicateEventIds: string[] = [];
      const docs: Array<Record<string, unknown>> = [];
      let latestAuthDevice: { action: string; at: Date; device: NonNullable<ReturnType<typeof normalizeDeviceInput>> } | null =
        null;

      for (const raw of parsed.data.events) {
        const screen = screenEventSchema.safeParse(raw);
        if (screen.success) {
          if (SKIP_SCREENS.has(screen.data.screen)) {
            acknowledgedEventIds.push(screen.data.eventId);
            continue;
          }
          const enteredAt = parseIso(screen.data.enteredAt);
          const exitedAt = parseIso(screen.data.exitedAt);
          if (!enteredAt || !exitedAt) continue;
          docs.push({
            eventId: screen.data.eventId,
            userId,
            type: 'screen_time',
            occurredAt: enteredAt,
            screen: screen.data.screen,
            path: screen.data.path ?? '',
            enteredAt,
            exitedAt,
            durationMs: screen.data.durationMs,
            exitReason: screen.data.exitReason ?? '',
          });
          continue;
        }
        const auth = authEventSchema.safeParse(raw);
        if (auth.success) {
          const at = parseIso(auth.data.at);
          if (!at) continue;
          const device = normalizeDeviceInput(auth.data.device ?? null);
          docs.push({
            eventId: auth.data.eventId,
            userId,
            type: 'auth',
            occurredAt: at,
            action: auth.data.action,
            ...(device ? { device } : {}),
          });
          if (device && (!latestAuthDevice || at.getTime() >= latestAuthDevice.at.getTime())) {
            latestAuthDevice = { action: auth.data.action, at, device };
          }
        }
      }

      if (docs.length > 0) {
        const ids = docs.map((d) => String(d.eventId));
        try {
          await AnalyticsEventModel.insertMany(docs, { ordered: false });
          acknowledgedEventIds.push(...ids);
        } catch (err: unknown) {
          const e = err as { code?: number; writeErrors?: Array<{ code?: number }> };
          const isDup =
            e.code === 11000 || (e.writeErrors ?? []).some((w) => w.code === 11000);
          if (!isDup) throw err;
          const existing = await AnalyticsEventModel.find({ eventId: { $in: ids } })
            .select('eventId')
            .lean();
          const have = new Set(existing.map((row) => row.eventId));
          for (const id of ids) {
            if (have.has(id)) duplicateEventIds.push(id);
            else acknowledgedEventIds.push(id);
          }
        }
      }

      // Keep lastDevice fresh on login/signup/logout analytics (logout otherwise never updates it).
      if (latestAuthDevice) {
        const user = await UserModel.findById(userId).select('firstDevice lastDevice').lean();
        if (user) {
          const next = applyDeviceSnapshot(
            { firstDevice: user.firstDevice, lastDevice: user.lastDevice },
            latestAuthDevice.device,
            false,
            latestAuthDevice.at,
          );
          await UserModel.updateOne(
            { _id: new Types.ObjectId(userId) },
            { $set: { firstDevice: next.firstDevice, lastDevice: next.lastDevice } },
          );
        }
      } else if (parsed.data.app) {
        const now = new Date();
        await UserModel.updateOne(
          { _id: new Types.ObjectId(userId), lastDevice: { $exists: true } },
          {
            $set: {
              'lastDevice.appVersion': parsed.data.app.version,
              'lastDevice.appBuild': parsed.data.app.build,
              ...(parsed.data.app.platform
                ? { 'lastDevice.platform': parsed.data.app.platform }
                : {}),
              'lastDevice.at': now,
            },
          },
        );
      }

      return reply.send({
        ok: true,
        data: { acknowledgedEventIds, duplicateEventIds },
      });
    },
  );

  app.get(
    '/api/v1/analytics/summary',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const q = req.query as { from?: string; to?: string };
      const to = parseIso(q.to ?? '') ?? new Date();
      const from = parseIso(q.from ?? '') ?? new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      if (from.getTime() >= to.getTime()) {
        return reply.status(400).send({ ok: false, error: { message: 'Invalid from/to' } });
      }
      if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) {
        return reply.status(400).send({ ok: false, error: { message: 'Range too large' } });
      }

      const userId = new Types.ObjectId(req.userId!);
      const match = { userId, occurredAt: { $gte: from, $lte: to } };

      const [facet, user] = await Promise.all([
        AnalyticsEventModel.aggregate<{
          screens: Array<{ _id: string; durationMs: number; count: number }>;
          auth: Array<{ _id: string; count: number }>;
          totals: Array<{ durationMs: number }>;
        }>([
          { $match: match },
          {
            $facet: {
              screens: [
                { $match: { type: 'screen_time' } },
                {
                  $group: {
                    _id: '$screen',
                    durationMs: { $sum: '$durationMs' },
                    count: { $sum: 1 },
                  },
                },
                { $sort: { durationMs: -1 } },
              ],
              auth: [
                { $match: { type: 'auth' } },
                { $group: { _id: '$action', count: { $sum: 1 } } },
              ],
              totals: [
                { $match: { type: 'screen_time' } },
                { $group: { _id: null, durationMs: { $sum: '$durationMs' } } },
              ],
            },
          },
        ]),
        UserModel.findById(userId).select('firstDevice lastDevice').lean(),
      ]);

      const row = facet[0];
      return reply.send({
        ok: true,
        data: {
          from: from.toISOString(),
          to: to.toISOString(),
          totalDurationMs: row?.totals[0]?.durationMs ?? 0,
          screens: (row?.screens ?? []).map((s) => ({
            screen: s._id,
            durationMs: s.durationMs,
            count: s.count,
          })),
          auth: Object.fromEntries((row?.auth ?? []).map((a) => [a._id || 'unknown', a.count])),
          firstDevice: user?.firstDevice ?? null,
          lastDevice: user?.lastDevice ?? null,
        },
      });
    },
  );
}
