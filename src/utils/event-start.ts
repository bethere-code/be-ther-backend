import { parseEventDateToIso } from './event-date.js';
import { normalizeTimeZone, zonedWallTimeToUtc } from './timezone.js';

/** Parse `HH:mm` or `h:mm AM/PM` into hours/minutes. */
export function parseEventTimeParts(
  timeRaw?: string | null,
): { hour: number; minute: number } | null {
  if (!timeRaw?.trim()) return { hour: 0, minute: 0 };
  const trimmed = timeRaw.trim();
  const twelve = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = Number(twelve[2]);
    const period = twelve[3]!.toUpperCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
      return null;
    }
    hour = period === 'AM' ? hour % 12 : (hour % 12) + 12;
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

/** Absolute start instant for an event in its stored timezone (date-only → local midnight). */
export function eventStartUtc(opts: {
  date?: string | null;
  time?: string | null;
  timeZone?: string | null;
  fallbackTimeZone?: string;
}): Date | null {
  const iso = parseEventDateToIso(opts.date);
  if (!iso) return null;
  const parts = parseEventTimeParts(opts.time);
  if (!parts) return null;
  const tz = normalizeTimeZone(opts.timeZone, opts.fallbackTimeZone ?? 'Asia/Kolkata');
  return zonedWallTimeToUtc(iso, parts.hour, parts.minute, tz);
}
