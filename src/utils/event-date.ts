const monthMap: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Normalizes event date strings (ISO or "Jul 15-18, 2026") to YYYY-MM-DD. */
export function parseEventDateToIso(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  const rangeMatch = trimmed.match(/([A-Za-z]+)\s+(\d+)(?:-\d+)?,\s*(\d{4})/);
  if (rangeMatch) {
    const [, monthRaw, dayRaw, yearRaw] = rangeMatch;
    if (!monthRaw || !dayRaw || !yearRaw) return null;
    const month = monthMap[monthRaw.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    const day = Number(dayRaw);
    const year = Number(yearRaw);
    if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // Day-first: "10 aug 2026" / "10 August, 2026" — do not use Date.parse (TZ day shift).
  const dayFirst = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)(?:\s+|,\s*)(\d{4})$/);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = monthMap[dayFirst[2]!.slice(0, 3).toLowerCase()];
    const year = Number(dayFirst[3]);
    if (month !== undefined && day >= 1 && day <= 31 && year >= 1970) {
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const monthFirst = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s+|,\s*)(\d{4})$/);
  if (monthFirst) {
    const month = monthMap[monthFirst[1]!.slice(0, 3).toLowerCase()];
    const day = Number(monthFirst[2]);
    const year = Number(monthFirst[3]);
    if (month !== undefined && day >= 1 && day <= 31 && year >= 1970) {
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

/**
 * Member badges — paused for now.
 * Later: combine activity, eventsCount, followersCount, etc.
 */
export function computeMemberBadge(_score: number): 'blue' | 'silver' | 'gold' | null {
  // if (_score >= 2500) return 'gold';
  // if (_score >= 1200) return 'blue';
  // if (_score >= 400) return 'silver';
  return null;
}

export function formatJoinedDate(createdAt?: Date | string): string {
  if (!createdAt) return '';
  const date = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function todayIsoLocal(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Minutes after start before an event is treated as past. From EVENT_PAST_GRACE_MINUTES. */
export function eventPastGraceMinutes(): number {
  const raw = process.env.EVENT_PAST_GRACE_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60;
  return Math.floor(n);
}

/** Parse `HH:mm` or `h:mm AM/PM` into local hours/minutes. */
function parseTimeParts(timeRaw: string): { hour: number; minute: number } | null {
  const trimmed = timeRaw.trim();
  const twelve = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = Number(twelve[2]);
    const period = twelve[3]!.toUpperCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
      return null;
    }
    if (period === 'AM') {
      hour = hour % 12;
    } else {
      hour = (hour % 12) + 12;
    }
    if (hour < 0 || hour > 23) return null;
    return { hour, minute };
  }

  const twentyFour = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    return { hour, minute };
  }

  return null;
}

function eventStartLocal(isoDate: string, timeRaw: string): Date | null {
  const parts = parseTimeParts(timeRaw);
  if (!parts) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, parts.hour, parts.minute, 0, 0);
}

/**
 * True when the event is considered past.
 * With a time: past only after start + EVENT_PAST_GRACE_MINUTES.
 * Date-only: past once the calendar day is before today.
 */
export function isEventPast(
  dateRaw?: string | null,
  timeRaw?: string | null,
  now: Date = new Date(),
): boolean {
  const iso = parseEventDateToIso(dateRaw);
  if (!iso) return false;

  const time = timeRaw?.trim();
  if (time) {
    const start = eventStartLocal(iso, time);
    if (!start) return false;
    const graceMs = eventPastGraceMinutes() * 60 * 1000;
    return now.getTime() >= start.getTime() + graceMs;
  }

  const today = todayIsoLocal(now);
  return iso < today;
}

type PostLike = {
  eventDetails?: { date?: string | null; time?: string | null } | null;
  createdAt?: Date | string;
};

/** Resolves the calendar date for a post and checks if the event has ended. */
export function isPostEventPast(post: PostLike, now: Date = new Date()): boolean {
  const ed = post.eventDetails ?? undefined;
  const iso =
    parseEventDateToIso(ed?.date) ??
    (post.createdAt
      ? new Date(post.createdAt).toISOString().slice(0, 10)
      : null);
  if (!iso) return false;
  return isEventPast(iso, ed?.time ?? undefined, now);
}
