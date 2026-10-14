import type { Types } from 'mongoose';

import type { Env } from '../config/env.js';
import { revokeAppleToken } from '../lib/apple.js';
import { AnalyticsEventModel } from '../models/analytics-event.model.js';
import { BlockModel } from '../models/block.model.js';
import { BookmarkModel } from '../models/bookmark.model.js';
import { CalendarModel } from '../models/calendar.model.js';
import { CommentLikeModel } from '../models/comment-like.model.js';
import { CommentModel } from '../models/comment.model.js';
import { ExploreBookmarkModel } from '../models/explore-bookmark.model.js';
import { FollowModel } from '../models/follow.model.js';
import { LikeModel } from '../models/like.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { OtpChallengeModel } from '../models/otp-challenge.model.js';
import { PostReportModel } from '../models/post-report.model.js';
import { PostViewModel } from '../models/post-view.model.js';
import { PostModel } from '../models/post.model.js';
import { ProfileCalendarHiddenModel } from '../models/profile-calendar-hidden.model.js';
import { UserReportModel } from '../models/user-report.model.js';
import { UserModel } from '../models/user.model.js';

/** Pipeline update: decrement a counter without going below zero. */
function decrementClamped(field: string, by = 1) {
  return [{ $set: { [field]: { $max: [0, { $subtract: [`$${field}`, by] }] } } }];
}
const PIPELINE = { updatePipeline: true } as const;

/** Remove posts and everything hanging off them (likes, comments, calendar rows, …). */
export async function deletePostsCascade(postIds: Types.ObjectId[]): Promise<void> {
  if (postIds.length === 0) return;
  const byPost = { postId: { $in: postIds } };
  const commentIds = (await CommentModel.find(byPost).select('_id').lean()).map((c) => c._id);

  await Promise.all([
    LikeModel.deleteMany(byPost),
    BookmarkModel.deleteMany(byPost),
    CalendarModel.deleteMany(byPost),
    NotificationModel.deleteMany(byPost),
    ProfileCalendarHiddenModel.deleteMany(byPost),
    CommentModel.deleteMany(byPost),
    commentIds.length > 0
      ? CommentLikeModel.deleteMany({ commentId: { $in: commentIds } })
      : Promise.resolve(),
    PostModel.deleteMany({ _id: { $in: postIds } }),
  ]);
}

/**
 * Permanently delete a user and their data (App Store 5.1.1(v)).
 * ponytail: uploaded images (avatar, covers) stay in storage — no delete helper exists
 * yet; add one in lib/storage.ts and call it here when needed.
 */
export async function deleteAccount(env: Env, userId: string): Promise<boolean> {
  const user = await UserModel.findById(userId).select('+appleRefreshToken');
  if (!user) return false;
  const uid = user._id;

  const ownPostIds = (await PostModel.find({ authorId: uid }).select('_id').lean()).map(
    (p) => p._id,
  );
  await deletePostsCascade(ownPostIds);

  // Activity left on other people's posts / profiles: undo denormalized counters first.
  const [likes, calendarRows, comments, commentLikes, follows] = await Promise.all([
    LikeModel.find({ userId: uid }).select('postId').lean(),
    CalendarModel.find({ userId: uid }).select('postId').lean(),
    CommentModel.find({ authorId: uid }).select('_id postId').lean(),
    CommentLikeModel.find({ userId: uid }).select('commentId').lean(),
    FollowModel.find({ $or: [{ followerId: uid }, { followingId: uid }] })
      .select('followerId followingId status')
      .lean(),
  ]);

  const commentsPerPost = new Map<string, number>();
  for (const c of comments) {
    const key = String(c.postId);
    commentsPerPost.set(key, (commentsPerPost.get(key) ?? 0) + 1);
  }
  const accepted = follows.filter((f) => f.status !== 'pending');
  const followingIds = accepted
    .filter((f) => String(f.followerId) === String(uid))
    .map((f) => f.followingId);
  const followerIds = accepted
    .filter((f) => String(f.followingId) === String(uid))
    .map((f) => f.followerId);

  await Promise.all([
    PostModel.updateMany(
      { _id: { $in: likes.map((l) => l.postId) } },
      decrementClamped('likesCount'),
      PIPELINE,
    ),
    PostModel.updateMany(
      { _id: { $in: calendarRows.map((c) => c.postId) } },
      decrementClamped('calendarCount'),
      PIPELINE,
    ),
    ...[...commentsPerPost].map(([postId, n]) =>
      PostModel.updateOne({ _id: postId }, decrementClamped('commentsCount', n), PIPELINE),
    ),
    CommentModel.updateMany(
      { _id: { $in: commentLikes.map((l) => l.commentId) } },
      decrementClamped('likesCount'),
      PIPELINE,
    ),
    UserModel.updateMany(
      { _id: { $in: followingIds } },
      decrementClamped('followersCount'),
      PIPELINE,
    ),
    UserModel.updateMany(
      { _id: { $in: followerIds } },
      decrementClamped('followingCount'),
      PIPELINE,
    ),
  ]);

  const ownCommentIds = comments.map((c) => c._id);
  await Promise.all([
    LikeModel.deleteMany({ userId: uid }),
    CalendarModel.deleteMany({ userId: uid }),
    CommentLikeModel.deleteMany({
      $or: [{ userId: uid }, { commentId: { $in: ownCommentIds } }],
    }),
    CommentModel.deleteMany({ authorId: uid }),
    BookmarkModel.deleteMany({ userId: uid }),
    ExploreBookmarkModel.deleteMany({ userId: uid }),
    PostViewModel.deleteMany({ userId: uid }),
    ProfileCalendarHiddenModel.deleteMany({ profileUserId: uid }),
    FollowModel.deleteMany({ $or: [{ followerId: uid }, { followingId: uid }] }),
    BlockModel.deleteMany({ $or: [{ blockerId: uid }, { blockedId: uid }] }),
    NotificationModel.deleteMany({ $or: [{ userId: uid }, { actorUserId: uid }] }),
    AnalyticsEventModel.deleteMany({ userId: uid }),
    UserReportModel.deleteMany({ $or: [{ reporterId: uid }, { reportedUserId: uid }] }),
    PostReportModel.deleteMany({ $or: [{ reporterId: uid }, { postId: { $in: ownPostIds } }] }),
    PostModel.updateMany({ taggedUserIds: uid }, { $pull: { taggedUserIds: uid } }),
    OtpChallengeModel.deleteMany({ email: user.email }),
  ]);

  const appleToken = user.get('appleRefreshToken') as string | undefined;
  if (appleToken) {
    // Best effort — Apple being down must not block deletion.
    await revokeAppleToken(env, appleToken).catch(() => false);
  }

  await user.deleteOne();
  return true;
}
