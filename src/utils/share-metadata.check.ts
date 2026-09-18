import assert from 'node:assert/strict';
import { Types } from 'mongoose';

import {
  renderShareNotFoundPage,
  resolveShareCoverAspect,
  resolveStoreUrl,
} from './share-metadata.js';
import type { Env } from '../config/env.js';

const id = new Types.ObjectId();

assert.equal(
  resolveShareCoverAspect({ _id: id, location: 'x', coverAspectRatio: 1.5 }),
  '1.5',
);
assert.equal(
  resolveShareCoverAspect({ _id: id, location: 'x', usesDefaultCover: true }),
  String(16 / 9),
);
assert.equal(
  resolveShareCoverAspect({ _id: id, location: 'x' }),
  String(16 / 9),
);

const stores = {
  ANDROID_STORE_URL: 'https://play.example/a',
  IOS_STORE_URL: 'https://ios.example/a',
  PUBLIC_BASE_URL: 'https://be-ther.com',
} as Env;

assert.equal(resolveStoreUrl(stores, 'iPhone'), 'https://ios.example/a');
assert.equal(resolveStoreUrl(stores, 'Android'), 'https://play.example/a');
assert.equal(resolveStoreUrl({} as Env, 'Desktop'), '#');

const notFound = renderShareNotFoundPage(stores, { userAgent: 'iPhone' });
assert.match(notFound, /Get Be Ther/);
assert.match(notFound, /Back to Be Ther/);
assert.match(notFound, /https:\/\/ios\.example\/a/);
assert.match(notFound, /--coral:#d4745e/);
assert.match(notFound, /This event isn’t here anymore/);

const notFoundAndroid = renderShareNotFoundPage(stores, {
  userAgent: 'Android',
});
assert.match(notFoundAndroid, /https:\/\/play\.example\/a/);

console.log('share-metadata.check: ok');
