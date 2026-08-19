import assert from 'node:assert/strict';

import { compareExplorePosts, isPostEventPast } from '../utils/event-date.js';

/** Same explore pipeline: 400 newest → drop past → sort → page. */
function explorePage<T extends Record<string, unknown>>(
  scanned: T[],
  skip: number,
  limit: number,
): T[] {
  const upcoming = scanned.filter((post) => !isPostEventPast(post as never));
  upcoming.sort((a, b) => compareExplorePosts(a as never, b as never));
  return upcoming.slice(skip, skip + limit);
}

const scanned = [
  {
    _id: 'b',
    likesCount: 1,
    commentsCount: 0,
    createdAt: new Date('2026-08-01'),
    eventDetails: { date: '2026-12-01' },
  },
  {
    _id: 'a',
    likesCount: 9,
    commentsCount: 0,
    createdAt: new Date('2026-08-02'),
    eventDetails: { date: '2026-12-01' },
  },
  {
    _id: 'past',
    likesCount: 99,
    createdAt: new Date('2026-01-01'),
    eventDetails: { date: '2020-01-01' },
  },
];

const page = explorePage(scanned, 0, 50);
assert.equal(page.length, 2);
assert.equal(page[0]!._id, 'a');
assert.equal(page[1]!._id, 'b');
assert.equal(explorePage(scanned, 1, 1)[0]!._id, 'b');

console.log('read-hot-path.check.ts ok');
