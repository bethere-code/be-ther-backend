import type { Types } from 'mongoose';

import {
  EVENT_NUDGE_SETTINGS_DEFAULTS,
  EventNudgeSettingsModel,
  type EventNudgeSettings,
} from '../models/event-nudge-settings.model.js';
import { CalendarModel } from '../models/calendar.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import { sendToUser } from './fcm.service.js';
import { goingNudgeCopy, interestedNudgeCopy } from '../utils/nudge-copy.js';
import { eventStartUtc } from '../utils/event-start.js';
import {
  localDateIso,
  normalizeTimeZone,
  randomQuietFireAt,
} from '../utils/timezone.js';

type Cache = { at: number; settings: EventNudgeSettings };
let cache: Cache | null = null;
const CACHE_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let started = false;

function asSettings(doc: Record<string, unknown> | null | undefined): EventNudgeSettings {
  const d = doc ?? {};
  return {
    ...EVENT_NUDGE_SETTINGS_DEFAULTS,
    ...d,
    key: 'event_nudges',
    quietStartHour: Number(d.quietStartHour ?? 10),
    quietEndHour: Number(d.quietEndHour ?? 20),
    goingHoursBefore: Number(d.goingHoursBefore ?? 6),
    tickIntervalMinutes: Number(d.tickIntervalMinutes ?? 5),
    runner: (d.runner as EventNudgeSettings['runner']) ?? 'interval',
    defaultTimezone: String(d.defaultTimezone ?? 'Asia/Kolkata'),
    enabled: d.enabled !== false,
    interestedEnabled: d.interestedEnabled !== false,
    goingEnabled: d.goingEnabled !== false,
  };
}

export async function getEventNudgeSettings(force = false): Promise<EventNudgeSettings> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.settings;
  let doc = await EventNudgeSettingsModel.findOne({ key: 'event_nudges' }).lean();
  if (!doc) {
    await EventNudgeSettingsModel.findOneAndUpdate(
      { key: 'event_nudges' },
      { $setOnInsert: EVENT_NUDGE_SETTINGS_DEFAULTS },
      { upsert: true },
    );
    doc = await EventNudgeSettingsModel.findOne({ key: 'event_nudges' }).lean();
  }
  const settings = asSettings(doc as never);
  cache = { at: Date.now(), settings };
  return settings;
}

export async function updateEventNudgeSettings(
  patch: Partial<EventNudgeSettings>,
): Promise<EventNudgeSettings> {
  const allowed: (keyof EventNudgeSettings)[] = [
    'enabled',
    'interestedEnabled',
    'goingEnabled',
    'quietStartHour',
    'quietEndHour',
    'goingHoursBefore',
    'tickIntervalMinutes',
    'runner',
    'defaultTimezone',
  ];
  const $set: Record<string, unknown> = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) $set[k] = patch[k];
  }
  $set.key = 'event_nudges';
  const doc = await EventNudgeSettingsModel.findOneAndUpdate(
    { key: 'event_nudges' },
    { $set, $setOnInsert: { key: 'event_nudges' } },
    { upsert: true, new: true },
  ).lean();
  cache = null;
  const settings = asSettings(doc as never);
  // Runner change → reschedule loop.
  restartNudgeRunner(settings);
  return settings;
}

function userTz(
  user: { timezone?: string | null },
  fallback: string,
): string {
  return normalizeTimeZone(user.timezone, fallback);
}

async function ensureInterestedSchedule(
  userId: Types.ObjectId,
  settings: EventNudgeSettings,
): Promise<void> {
  const user = await UserModel.findById(userId)
    .select('timezone nudge')
    .lean();
  if (!user) return;
  const nudge = (user.nudge ?? {}) as {
    interestedNextAt?: Date;
    interestedSentLocalDate?: string;
  };
  if (nudge.interestedNextAt && new Date(nudge.interestedNextAt).getTime() > Date.now()) {
    return;
  }
  const tz = userTz(user, settings.defaultTimezone);
  const next = randomQuietFireAt({
    timeZone: tz,
    quietStartHour: settings.quietStartHour,
    quietEndHour: settings.quietEndHour,
  });
  await UserModel.updateOne(
    { _id: userId },
    { $set: { 'nudge.interestedNextAt': next } },
  );
}

export async function onCalendarStatusChanged(opts: {
  userId: string;
  status: 'interested' | 'going' | 'none';
}): Promise<void> {
  try {
    const settings = await getEventNudgeSettings();
    if (!settings.enabled) return;
    const userId = opts.userId as unknown as Types.ObjectId;
    if (opts.status === 'interested' && settings.interestedEnabled) {
      await ensureInterestedSchedule(userId as never, settings);
    }
    if (opts.status === 'going') {
      // Going uses calendar.goingNudgeSentAt; clear interested schedule if no interested left.
      const still = await CalendarModel.exists({
        userId,
        status: 'interested',
      });
      if (!still) {
        await UserModel.updateOne(
          { _id: userId },
          { $unset: { 'nudge.interestedNextAt': 1 } },
        );
      }
    }
    if (opts.status === 'none') {
      const still = await CalendarModel.exists({
        userId,
        status: 'interested',
      });
      if (!still) {
        await UserModel.updateOne(
          { _id: userId },
          { $unset: { 'nudge.interestedNextAt': 1 } },
        );
      }
    }
  } catch (err) {
    console.warn('[nudge] onCalendarStatusChanged failed', err);
  }
}

type PostLean = {
  _id: Types.ObjectId;
  location?: string;
  eventDetails?: {
    date?: string | null;
    time?: string | null;
    timezone?: string | null;
    venue?: string | null;
  } | null;
};

async function loadFuturePosts(
  postIds: Types.ObjectId[],
  settings: EventNudgeSettings,
  now: Date,
): Promise<Map<string, { post: PostLean; start: Date }>> {
  if (postIds.length === 0) return new Map();
  const posts = (await PostModel.find({ _id: { $in: postIds } })
    .select('location eventDetails')
    .lean()) as PostLean[];
  const map = new Map<string, { post: PostLean; start: Date }>();
  for (const post of posts) {
    const start = eventStartUtc({
      date: post.eventDetails?.date,
      time: post.eventDetails?.time,
      timeZone: post.eventDetails?.timezone,
      fallbackTimeZone: settings.defaultTimezone,
    });
    if (!start) continue;
    if (start.getTime() <= now.getTime()) continue;
    map.set(String(post._id), { post, start });
  }
  return map;
}

async function processInterested(settings: EventNudgeSettings, now: Date): Promise<number> {
  if (!settings.interestedEnabled) return 0;
  const dueUsers = await UserModel.find({
    'nudge.interestedNextAt': { $lte: now },
    'settings.pushEnabled': { $ne: false },
  })
    .select('_id timezone nudge')
    .limit(80)
    .lean();

  let sent = 0;
  for (const user of dueUsers) {
    const uid = user._id as Types.ObjectId;
    const cals = await CalendarModel.find({ userId: uid, status: 'interested' })
      .select('postId')
      .lean();
    const postIds = cals.map((c) => c.postId as Types.ObjectId);
    const future = await loadFuturePosts(postIds, settings, now);
    const events = [...future.values()]
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((x) => ({
        name: x.post.location || 'Event',
        venue: x.post.eventDetails?.venue,
        postId: String(x.post._id),
        start: x.start,
      }));

    const tz = userTz(user, settings.defaultTimezone);
    const localDay = localDateIso(now, tz);
    const lastSent = String(
      (user.nudge as { interestedSentLocalDate?: string } | undefined)
        ?.interestedSentLocalDate ?? '',
    );

    if (events.length === 0) {
      await UserModel.updateOne(
        { _id: uid },
        { $unset: { 'nudge.interestedNextAt': 1 } },
      );
      continue;
    }

    if (lastSent === localDay) {
      // Already nudged today — schedule tomorrow's random slot.
      const next = randomQuietFireAt({
        now,
        timeZone: tz,
        quietStartHour: settings.quietStartHour,
        quietEndHour: settings.quietEndHour,
        onLocalDate: localDateIso(new Date(now.getTime() + 36 * 3600_000), tz),
      });
      await UserModel.updateOne(
        { _id: uid },
        { $set: { 'nudge.interestedNextAt': next } },
      );
      continue;
    }

    const copy = interestedNudgeCopy(
      events.map((e) => ({ name: e.name, venue: e.venue })),
      `${uid}:${localDay}`,
    );
    const openId = events[0]!.postId;
    await sendToUser(String(uid), {
      title: copy.title,
      body: copy.body,
      data: {
        type: 'nudge',
        kind: 'interested',
        screen: 'event',
        id: openId,
        postId: openId,
      },
    });
    sent += 1;

    const next = randomQuietFireAt({
      now: new Date(now.getTime() + 60_000),
      timeZone: tz,
      quietStartHour: settings.quietStartHour,
      quietEndHour: settings.quietEndHour,
      onLocalDate: localDateIso(new Date(now.getTime() + 36 * 3600_000), tz),
    });
    await UserModel.updateOne(
      { _id: uid },
      {
        $set: {
          'nudge.interestedNextAt': next,
          'nudge.interestedSentLocalDate': localDay,
        },
      },
    );
  }
  return sent;
}

async function processGoing(settings: EventNudgeSettings, now: Date): Promise<number> {
  if (!settings.goingEnabled) return 0;
  const windowMs = settings.goingHoursBefore * 3600_000;
  const cals = await CalendarModel.find({
    status: 'going',
    goingNudgeSentAt: { $exists: false },
  })
    .select('_id userId postId')
    .limit(200)
    .lean();

  if (cals.length === 0) return 0;

  const postIds = [...new Set(cals.map((c) => String(c.postId)))].map(
    (id) => id as unknown as Types.ObjectId,
  );
  const posts = (await PostModel.find({ _id: { $in: postIds } })
    .select('location eventDetails')
    .lean()) as PostLean[];
  const byId = new Map(posts.map((p) => [String(p._id), p]));

  let sent = 0;
  for (const cal of cals) {
    const post = byId.get(String(cal.postId));
    const start = eventStartUtc({
      date: post?.eventDetails?.date,
      time: post?.eventDetails?.time,
      timeZone: post?.eventDetails?.timezone,
      fallbackTimeZone: settings.defaultTimezone,
    });
    if (!start || start.getTime() <= now.getTime()) {
      await CalendarModel.updateOne(
        { _id: cal._id },
        { $set: { goingNudgeSentAt: now } },
      );
      continue;
    }
    const msUntil = start.getTime() - now.getTime();
    if (msUntil > windowMs) continue;

    const user = await UserModel.findById(cal.userId)
      .select('settings.pushEnabled')
      .lean();
    if (user?.settings && (user.settings as { pushEnabled?: boolean }).pushEnabled === false) {
      continue;
    }

    const copy = goingNudgeCopy(
      {
        name: post?.location || 'Event',
        venue: post?.eventDetails?.venue,
      },
      `${cal.userId}:${cal.postId}`,
    );
    const postId = String(cal.postId);
    await sendToUser(String(cal.userId), {
      title: copy.title,
      body: copy.body,
      data: {
        type: 'nudge',
        kind: 'going',
        screen: 'event',
        id: postId,
        postId,
      },
    });
    await CalendarModel.updateOne(
      { _id: cal._id },
      { $set: { goingNudgeSentAt: now } },
    );
    sent += 1;
  }
  return sent;
}

export type NudgeTickResult = {
  ok: true;
  interestedSent: number;
  goingSent: number;
  skipped: boolean;
  reason?: string;
};

export async function runNudgeTick(): Promise<NudgeTickResult> {
  if (ticking) {
    return { ok: true, interestedSent: 0, goingSent: 0, skipped: true, reason: 'busy' };
  }
  ticking = true;
  try {
    const settings = await getEventNudgeSettings(true);
    if (!settings.enabled) {
      return { ok: true, interestedSent: 0, goingSent: 0, skipped: true, reason: 'disabled' };
    }
    const now = new Date();
    const interestedSent = await processInterested(settings, now);
    const goingSent = await processGoing(settings, now);
    return { ok: true, interestedSent, goingSent, skipped: false };
  } finally {
    ticking = false;
  }
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext(settings: EventNudgeSettings): void {
  clearTimer();
  if (settings.runner !== 'interval' || !settings.enabled) return;
  const ms = Math.max(2, settings.tickIntervalMinutes) * 60_000;
  timer = setTimeout(() => {
    void runNudgeTick()
      .catch((err) => console.warn('[nudge] tick failed', err))
      .finally(() => {
        void getEventNudgeSettings().then(scheduleNext);
      });
  }, ms);
  // Don't keep the event loop artificially "busy" from Node's POV.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
}

function restartNudgeRunner(settings: EventNudgeSettings): void {
  clearTimer();
  if (!started) return;
  scheduleNext(settings);
}

/** Call once after Mongo + FCM ready. Cheap: unref'd timer, settings cached 60s. */
export function startNudgeRunner(): void {
  if (started) return;
  started = true;
  void getEventNudgeSettings()
    .then((s) => {
      console.info(
        `[nudge] runner=${s.runner} enabled=${s.enabled} intervalMin=${s.tickIntervalMinutes}`,
      );
      scheduleNext(s);
    })
    .catch((err) => console.warn('[nudge] failed to start', err));
}

export function stopNudgeRunner(): void {
  clearTimer();
  started = false;
}
