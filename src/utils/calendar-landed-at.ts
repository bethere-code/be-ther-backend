function toMs(value: Date | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** When this event landed on the profile calendar. RSVP uses the calendar row; authored uses the post. */
export function calendarLandedAtMs(opts: {
  source: 'authored' | 'calendar';
  postCreatedAt?: Date | string | null;
  calendarCreatedAt?: Date | string | null;
}): number {
  if (opts.source === 'calendar') {
    const fromRow = toMs(opts.calendarCreatedAt);
    if (fromRow != null) return fromRow;
  }
  return toMs(opts.postCreatedAt) ?? 0;
}

export function compareCalendarLandedAt(
  a: { landedAt: number; postId: string },
  b: { landedAt: number; postId: string },
): number {
  const byTime = a.landedAt - b.landedAt;
  if (byTime !== 0) return byTime;
  return a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0;
}
