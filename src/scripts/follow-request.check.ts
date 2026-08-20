import assert from 'node:assert/strict';

import { acceptedOnly } from '../models/follow.model.js';
import { privateProfileHidesContent } from '../services/follow.service.js';

assert.equal(privateProfileHidesContent(false, true, false), true);
assert.equal(privateProfileHidesContent(false, true, true), false);
assert.equal(privateProfileHidesContent(true, true, false), false);
assert.deepEqual(acceptedOnly({ followerId: 'x' }), {
  followerId: 'x',
  status: { $ne: 'pending' },
});

console.log('follow-request.check.ts ok');
