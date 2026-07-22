import { FollowModel } from '../models/follow.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { UserModel } from '../models/user.model.js';

export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  return Boolean(
    await FollowModel.exists({ followerId, followingId }),
  );
}

/** Both users follow each other (used for DM unlock + notification copy). */
export async function areMutualFollowers(a: string, b: string): Promise<boolean> {
  const [aFollowsB, bFollowsA] = await Promise.all([
    FollowModel.exists({ followerId: a, followingId: b }),
    FollowModel.exists({ followerId: b, followingId: a }),
  ]);
  return Boolean(aFollowsB && bFollowsA);
}

function clampCount(n: number | undefined): number {
  return Math.max(0, Number(n ?? 0));
}

/**
 * Toggle follow. Updates denormalized counters on both users (O(1) profile reads).
 * Returns whether `followerId` now follows `followingId`, plus the target's follower count.
 */
export async function toggleFollow(
  followerId: string,
  followingId: string,
): Promise<{ following: boolean; followersCount: number }> {
  if (followerId === followingId) {
    throw new Error('CANNOT_FOLLOW_SELF');
  }

  const existing = await FollowModel.findOne({ followerId, followingId });

  if (existing) {
    await existing.deleteOne();
    await Promise.all([
      UserModel.updateOne({ _id: followingId }, { $inc: { followersCount: -1 } }),
      UserModel.updateOne({ _id: followerId }, { $inc: { followingCount: -1 } }),
    ]);
    // Floor at 0 if counters ever drifted.
    await Promise.all([
      UserModel.updateOne(
        { _id: followingId, followersCount: { $lt: 0 } },
        { $set: { followersCount: 0 } },
      ),
      UserModel.updateOne(
        { _id: followerId, followingCount: { $lt: 0 } },
        { $set: { followingCount: 0 } },
      ),
    ]);
    const target = await UserModel.findById(followingId).select('followersCount').lean();
    return { following: false, followersCount: clampCount(target?.followersCount) };
  }

  try {
    await FollowModel.create({ followerId, followingId });
  } catch (err: unknown) {
    // Race: another request created the same edge — treat as already following.
    const code = (err as { code?: number })?.code;
    if (code !== 11000) throw err;
    const target = await UserModel.findById(followingId).select('followersCount').lean();
    return { following: true, followersCount: clampCount(target?.followersCount) };
  }

  await Promise.all([
    UserModel.updateOne({ _id: followingId }, { $inc: { followersCount: 1 } }),
    UserModel.updateOne({ _id: followerId }, { $inc: { followingCount: 1 } }),
  ]);

  const mutual = await areMutualFollowers(followerId, followingId);
  await NotificationModel.create({
    userId: followingId,
    type: 'follow',
    actorUserId: followerId,
    mutualFollow: mutual,
  });

  const target = await UserModel.findById(followingId).select('followersCount').lean();
  return { following: true, followersCount: clampCount(target?.followersCount) };
}
