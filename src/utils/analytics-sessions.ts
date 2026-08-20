/**
 * Group flat analytics events into user sessions (30m gap).
 * Shared by admin sessions API — keep in sync with website groupAnalyticsSessions intent.
 */

export const SESSION_GAP_MS = 30 * 60 * 1000;
/** ponytail: scan ceiling for one admin date range; raise or shard by day if ops grows past this. */
export const MAX_SESSION_SCAN = 5_000;

export type SessionUser = {
  id: string;
  name: string;
  username: string;
};

export type AnalyticsSession = {
  key: string;
  userId: string;
  user: SessionUser;
  screens: string[];
  totalMs: number;
  startedAt: string;
  endedAt: string;
  eventCount: number;
};

export type LeanEvent = {
  _id?: unknown;
  userId?: unknown;
  type?: string;
  action?: string | null;
  screen?: string;
  path?: string;
  occurredAt?: Date | string;
  enteredAt?: Date | string | null;
  exitedAt?: Date | string | null;
  durationMs?: number | null;
};

function userIdOf(ev: LeanEvent): string {
  const raw = ev.userId;
  if (raw && typeof raw === 'object' && '_id' in (raw as object)) {
    return String((raw as { _id: unknown })._id);
  }
  return String(raw ?? '');
}

function screenLabel(ev: LeanEvent): string {
  if (ev.type === 'auth') {
    const action = String(ev.action || 'auth');
    return action.charAt(0).toUpperCase() + action.slice(1);
  }
  const screen = String(ev.screen || ev.path || 'unknown').replace(/^\/+/, '');
  if (!screen) return 'Unknown';
  return screen.charAt(0).toUpperCase() + screen.slice(1);
}

function eventBounds(ev: LeanEvent): { start: number; end: number } {
  const start = new Date(String(ev.enteredAt || ev.occurredAt || 0)).getTime();
  const end = new Date(String(ev.exitedAt || ev.occurredAt || 0)).getTime();
  const s = Number.isFinite(start) ? start : 0;
  const e = Number.isFinite(end) ? end : s;
  return { start: s, end: Math.max(e, s) };
}

export function groupAnalyticsSessions(
  items: LeanEvent[],
  usersById: Map<string, SessionUser>,
  gapMs: number = SESSION_GAP_MS,
): AnalyticsSession[] {
  const sorted = [...items].sort((a, b) => {
    const ua = userIdOf(a);
    const ub = userIdOf(b);
    if (ua !== ub) return ua.localeCompare(ub);
    return eventBounds(a).start - eventBounds(b).start;
  });

  const sessions: AnalyticsSession[] = [];
  let cur: AnalyticsSession | null = null;
  let curEnd = 0;

  for (const ev of sorted) {
    const uid = userIdOf(ev);
    const { start, end } = eventBounds(ev);
    const label = screenLabel(ev);
    const isAuth = ev.type === 'auth';
    const duration = isAuth
      ? 0
      : Number(ev.durationMs ?? 0) || Math.max(0, end - start);

    const needsNew = !cur || cur.userId !== uid || start - curEnd > gapMs;

    if (needsNew) {
      const sessionUser: SessionUser =
        usersById.get(uid) ?? { id: uid, name: 'Unknown', username: '' };
      cur = {
        key: `${uid || 'anon'}-${start}-${sessions.length}`,
        userId: uid,
        user: sessionUser,
        screens: [],
        totalMs: 0,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(end).toISOString(),
        eventCount: 0,
      };
      sessions.push(cur);
      curEnd = end;
    }

    const session = cur!;
    session.eventCount += 1;
    if (!session.screens.includes(label)) session.screens.push(label);
    session.totalMs += duration;
    if (start < new Date(session.startedAt).getTime()) {
      session.startedAt = new Date(start).toISOString();
    }
    if (end > curEnd) {
      curEnd = end;
      session.endedAt = new Date(end).toISOString();
    }
  }

  return sessions;
}

export function sortSessions(
  sessions: AnalyticsSession[],
  sort: 'occurredAt' | 'durationMs',
  dir: 'asc' | 'desc',
): AnalyticsSession[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...sessions].sort((a, b) => {
    const av = sort === 'durationMs' ? a.totalMs : Date.parse(a.endedAt);
    const bv = sort === 'durationMs' ? b.totalMs : Date.parse(b.endedAt);
    return (av - bv) * mul;
  });
}

// Runnable: npx tsx src/utils/analytics-sessions.check.ts
export function selfCheckAnalyticsSessions(): void {
  const base = Date.parse('2026-08-20T06:53:00.000Z');
  const uid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const users = new Map<string, SessionUser>([
    [uid, { id: uid, name: 'Jhansi', username: 'jhansi' }],
  ]);
  const mk = (i: number, screen: string, offsetMs: number, dur: number): LeanEvent => ({
    _id: `e${i}`,
    type: 'screen_time',
    userId: uid,
    screen,
    occurredAt: new Date(base + offsetMs),
    enteredAt: new Date(base + offsetMs),
    exitedAt: new Date(base + offsetMs + dur),
    durationMs: dur,
  });

  const same = groupAnalyticsSessions(
    [mk(1, 'settings', 0, 34_000), mk(2, 'profile', 40_000, 2_000), mk(3, 'search', 50_000, 2_000)],
    users,
  );
  if (same.length !== 1) throw new Error(`expected 1 session, got ${same.length}`);
  const first = same[0]!;
  if (first.totalMs !== 38_000) throw new Error(`totalMs ${first.totalMs}`);
  if (first.screens.join(',') !== 'Settings,Profile,Search') {
    throw new Error(`screens ${first.screens.join(',')}`);
  }

  const split = groupAnalyticsSessions(
    [mk(1, 'feed', 0, 5_000), mk(2, 'explore', SESSION_GAP_MS + 60_000, 5_000)],
    users,
  );
  if (split.length !== 2) throw new Error(`expected 2 sessions after gap, got ${split.length}`);
}
