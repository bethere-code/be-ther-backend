/**
 * Run: npx tsx src/services/account.check.ts
 * Needs a local MongoDB (MONGODB_CHECK_URI, default mongodb://127.0.0.1:27017).
 * Uses a throwaway database that is dropped afterwards.
 */
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import type { Env } from '../config/env.js';
import { CalendarModel } from '../models/calendar.model.js';
import { CommentLikeModel } from '../models/comment-like.model.js';
import { CommentModel } from '../models/comment.model.js';
import { FollowModel } from '../models/follow.model.js';
import { LikeModel } from '../models/like.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import { deleteAccount } from './account.service.js';

const base = process.env.MONGODB_CHECK_URI ?? 'mongodb://127.0.0.1:27017';
await mongoose.connect(`${base}/be_ther_check_${Date.now()}`);

try {
  const env = { APPLE_BUNDLE_ID: 'com.bether.app' } as Env;
  const user = (n: string, extra: Record<string, unknown> = {}) => ({
    email: `${n}@example.com`,
    username: n,
    displayName: n,
    ...extra,
  });
  const [me, friend, other] = await UserModel.create([
    user('me', { followersCount: 1, followingCount: 1, appleSub: 'apple-me', appleRefreshToken: 'r' }),
    user('friend', { followersCount: 1, followingCount: 1 }),
    user('other'),
  ]);

  const post = (authorId: unknown, extra: Record<string, unknown> = {}) => ({
    authorId,
    location: 'Hyderabad',
    status: 'going',
    imageUrl: 'https://example.com/a.jpg',
    ...extra,
  });
  const [myPost, friendPost] = await PostModel.create([
    post(me._id, { likesCount: 1, commentsCount: 1, calendarCount: 1 }),
    post(friend._id, { likesCount: 1, commentsCount: 3, calendarCount: 2, taggedUserIds: [me._id] }),
  ]);

  const [, , friendComment] = await CommentModel.create([
    { postId: friendPost._id, authorId: me._id, text: 'one' },
    { postId: friendPost._id, authorId: me._id, text: 'two' },
    { postId: friendPost._id, authorId: friend._id, text: 'mine', likesCount: 1 },
    { postId: myPost._id, authorId: friend._id, text: 'on your post' },
  ]);
  await Promise.all([
    LikeModel.create([
      { userId: me._id, postId: friendPost._id },
      { userId: friend._id, postId: myPost._id },
    ]),
    CommentLikeModel.create({ userId: me._id, commentId: friendComment._id }),
    CalendarModel.create([
      { userId: me._id, postId: friendPost._id, status: 'going' },
      { userId: friend._id, postId: friendPost._id, status: 'going' },
      { userId: friend._id, postId: myPost._id, status: 'interested' },
    ]),
    FollowModel.create([
      { followerId: me._id, followingId: friend._id },
      { followerId: friend._id, followingId: me._id },
      { followerId: me._id, followingId: other._id, status: 'pending' },
    ]),
    NotificationModel.create([
      { userId: friend._id, type: 'like', actorUserId: me._id, postId: friendPost._id },
      { userId: me._id, type: 'like', actorUserId: friend._id, postId: myPost._id },
    ]),
  ]);

  assert.equal(await deleteAccount(env, String(me._id)), true);

  assert.equal(await UserModel.findById(me._id), null);
  assert.equal(await PostModel.findById(myPost._id), null);

  const fp = await PostModel.findById(friendPost._id).lean();
  assert.equal(fp?.likesCount, 0);
  assert.equal(fp?.commentsCount, 1);
  assert.equal(fp?.calendarCount, 1);
  assert.deepEqual(fp?.taggedUserIds, []);
  assert.equal((await CommentModel.findById(friendComment._id).lean())?.likesCount, 0);

  const f = await UserModel.findById(friend._id).lean();
  assert.equal(f?.followersCount, 0);
  assert.equal(f?.followingCount, 0);
  const o = await UserModel.findById(other._id).lean();
  assert.equal(o?.followersCount, 0);

  assert.equal(await LikeModel.countDocuments(), 0);
  assert.equal(await CommentModel.countDocuments(), 1);
  assert.equal(await CommentLikeModel.countDocuments(), 0);
  assert.equal(await CalendarModel.countDocuments(), 1);
  assert.equal(await FollowModel.countDocuments(), 0);
  assert.equal(await NotificationModel.countDocuments(), 0);

  assert.equal(await deleteAccount(env, String(me._id)), false);
  console.log('account.check OK');
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
