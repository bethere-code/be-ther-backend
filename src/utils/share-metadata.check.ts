import assert from 'node:assert/strict';
import { Types } from 'mongoose';

import { resolveShareCoverAspect } from './share-metadata.js';

const id = new Types.ObjectId();

assert.equal(
  resolveShareCoverAspect({ _id: id, location: 'x', coverAspectRatio: 1.5 }),
  '1.5',
);
assert.equal(
  resolveShareCoverAspect({ _id: id, location: 'x', usesDefaultCover: true }),
  String(3 / 4),
);
assert.equal(
  resolveShareCoverAspect({ _id: id, location: 'x' }),
  String(16 / 9),
);

console.log('share-metadata.check: ok');
