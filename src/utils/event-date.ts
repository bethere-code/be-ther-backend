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

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }

  return null;
}

export function computeMemberBadge(starsReceived: number): 'blue' | 'silver' | 'gold' | null {
  if (starsReceived >= 2500) return 'gold';
  if (starsReceived >= 1200) return 'blue';
  if (starsReceived >= 400) return 'silver';
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

/** True when the event date (and optional time) is before now. */
export function isEventPast(
  dateRaw?: string | null,
  timeRaw?: string | null,
  now: Date = new Date(),
): boolean {
  const iso = parseEventDateToIso(dateRaw);
  if (!iso) return false;

  const today = todayIsoLocal(now);
  if (iso < today) return true;
  if (iso > today) return false;

  const time = timeRaw?.trim();
  if (!time) return false;

  const parsed = Date.parse(`${iso}T${time}`);
  if (!Number.isNaN(parsed)) return parsed < now.getTime();

  const fallback = Date.parse(`${iso} ${time}`);
  if (!Number.isNaN(fallback)) return fallback < now.getTime();

  return false;
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
