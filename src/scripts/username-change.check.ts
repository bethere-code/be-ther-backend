import assert from 'node:assert/strict';

import { usernameChangeLocked } from '../utils/username-change.js';

assert.equal(usernameChangeLocked(undefined), false);
assert.equal(usernameChangeLocked(null), false);
assert.equal(usernameChangeLocked(new Date(Date.now() - 1000)), true);
assert.equal(usernameChangeLocked(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)), false);

console.log('username-change.check.ts ok');
