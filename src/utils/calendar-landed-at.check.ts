import {
  calendarLandedAtMs,
  compareCalendarLandedAt,
} from './calendar-landed-at.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const t0 = new Date('2026-01-01T10:00:00.000Z');
const t1 = new Date('2026-01-01T12:00:00.000Z');

assert(
  calendarLandedAtMs({ source: 'authored', postCreatedAt: t1, calendarCreatedAt: t0 }) ===
    t1.getTime(),
  'authored ignores calendar row',
);
assert(
  calendarLandedAtMs({ source: 'calendar', postCreatedAt: t0, calendarCreatedAt: t1 }) ===
    t1.getTime(),
  'rsvp uses calendar row',
);
assert(
  calendarLandedAtMs({ source: 'calendar', postCreatedAt: t0, calendarCreatedAt: null }) ===
    t0.getTime(),
  'rsvp falls back to post',
);

const ordered = [
  { landedAt: 20, postId: 'b' },
  { landedAt: 10, postId: 'z' },
  { landedAt: 10, postId: 'a' },
].sort(compareCalendarLandedAt);
assert(
  ordered.map((x) => x.postId).join(',') === 'a,z,b',
  'fifo then postId',
);

console.log('calendar-landed-at.check: ok');
