import assert from 'node:assert/strict';

import { goingNudgeCopy, interestedNudgeCopy } from './nudge-copy.js';
import {
  localDateIso,
  normalizeTimeZone,
  zonedWallTimeToUtc,
} from './timezone.js';
import { eventStartUtc } from './event-start.js';

assert.equal(normalizeTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
assert.equal(normalizeTimeZone('Not/AZone'), 'Asia/Kolkata');

const noon = zonedWallTimeToUtc('2026-09-17', 12, 0, 'Asia/Kolkata');
assert.ok(noon);
assert.equal(localDateIso(noon!, 'Asia/Kolkata'), '2026-09-17');

const start = eventStartUtc({
  date: '2026-09-17',
  time: '6:30 PM',
  timeZone: 'Asia/Kolkata',
});
assert.ok(start);
assert.ok(start!.getTime() > Date.parse('2026-09-17T00:00:00.000Z'));

const interested = interestedNudgeCopy([{ name: 'Jazz Night' }], 'seed-a');
assert.ok(interested.title.length > 3);
assert.ok(interested.body.length > 3);

const goingMusic = goingNudgeCopy({ name: 'Indie Concert Live' }, 'seed-b');
const goingFood = goingNudgeCopy({ name: 'Brunch Club' }, 'seed-c');
assert.notEqual(goingMusic.title, goingFood.title);

console.log('event-nudge.check: ok');
