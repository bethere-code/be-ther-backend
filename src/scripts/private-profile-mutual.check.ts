import assert from 'node:assert/strict';

import { privateProfileHidesContent } from '../services/follow.service.js';

assert.equal(privateProfileHidesContent(false, true, false), true);
assert.equal(privateProfileHidesContent(false, true, true), false);
assert.equal(privateProfileHidesContent(true, true, false), false);
assert.equal(privateProfileHidesContent(false, false, false), false);

console.log('private-profile-mutual.check.ts ok');
