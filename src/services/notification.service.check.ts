import assert from 'node:assert/strict';

import {
  buildSocialPushData,
  shouldSkipLikePush,
} from './notification.service.js';

const eventData = buildSocialPushData({
  notificationId: 'n1',
  kind: 'like',
  postId: '507f1f77bcf86cd799439011',
  username: 'alex',
});
assert.equal(eventData.screen, 'event');
assert.equal(eventData.id, '507f1f77bcf86cd799439011');
assert.equal(eventData.kind, 'like');

const profileData = buildSocialPushData({
  notificationId: 'n2',
  kind: 'follow',
  username: 'alex',
});
assert.equal(profileData.screen, 'profile');
assert.equal(profileData.id, 'alex');

const now = Date.now();
assert.equal(shouldSkipLikePush(new Date(now - 60 * 60 * 1000), now), true);
assert.equal(shouldSkipLikePush(new Date(now - 3 * 60 * 60 * 1000), now), false);
assert.equal(shouldSkipLikePush(undefined, now), false);

console.log('notification.service.check: ok');
