/** IANA timezone helpers — stdlib Intl only (no luxon). */

const FALLBACK_TZ = 'Asia/Kolkata';

export function normalizeTimeZone(raw?: string | null, fallback = FALLBACK_TZ): string {
  const tz = raw?.trim() || fallback;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

/** Local calendar date YYYY-MM-DD in [timeZone]. */
export function localDateIso(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes since local midnight in [timeZone]. */
export function localMinutesSinceMidnight(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/**
 * Instant for local wall time `YYYY-MM-DD` + hour:minute in [timeZone].
 * Iterates once to correct UTC↔offset (handles DST).
 */
export function zonedWallTimeToUtc(
  isoDate: string,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  const tz = normalizeTimeZone(timeZone);

  let utc = Date.UTC(y, mo - 1, d, hour, minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(new Date(utc), tz);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const target = Date.UTC(y, mo - 1, d, hour, minute, 0, 0);
    const diff = target - asUtc;
    if (diff === 0) break;
    utc += diff;
  }
  return new Date(utc);
}

/** Pick a random UTC instant today (or tomorrow if window already passed) in quiet hours. */
export function randomQuietFireAt(opts: {
  now?: Date;
  timeZone: string;
  quietStartHour: number;
  quietEndHour: number;
  /** Prefer scheduling on this local date (YYYY-MM-DD). */
  onLocalDate?: string;
}): Date {
  const now = opts.now ?? new Date();
  const tz = normalizeTimeZone(opts.timeZone);
  const startH = Math.max(0, Math.min(23, Math.floor(opts.quietStartHour)));
  let endH = Math.max(1, Math.min(24, Math.floor(opts.quietEndHour)));
  if (endH <= startH) endH = Math.min(24, startH + 1);

  const windowStartMin = startH * 60;
  const windowEndMin = endH * 60;
  const span = Math.max(1, windowEndMin - windowStartMin);

  let localDay = opts.onLocalDate ?? localDateIso(now, tz);
  const nowMin = localMinutesSinceMidnight(now, tz);
  if (!opts.onLocalDate && nowMin >= windowEndMin - 1) {
    // Window closed today → tomorrow.
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    localDay = localDateIso(tomorrow, tz);
  }

  const offset = Math.floor(Math.random() * span);
  const fireMin = windowStartMin + offset;
  const hour = Math.floor(fireMin / 60);
  const minute = fireMin % 60;
  const at = zonedWallTimeToUtc(localDay, hour, minute, tz);
  if (!at) return new Date(now.getTime() + 60 * 60 * 1000);

  // If we landed in the past (same-day late schedule), bump to tomorrow.
  if (at.getTime() <= now.getTime() + 30_000) {
    const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const nextDay = localDateIso(next, tz);
    const retry = zonedWallTimeToUtc(nextDay, hour, minute, tz);
    return retry ?? new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  return at;
}
