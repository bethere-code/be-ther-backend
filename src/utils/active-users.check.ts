import assert from 'node:assert/strict';

import { ACTIVE_USER_WINDOW_MINUTES, activeUsersSince } from './active-users.js';

assert.equal(ACTIVE_USER_WINDOW_MINUTES, 10);
const now = Date.parse('2026-10-05T12:00:00.000Z');
const since = activeUsersSince(now);
assert.equal(since.toISOString(), '2026-10-05T11:50:00.000Z');

console.log('active-users.check: ok');
