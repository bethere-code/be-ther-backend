import { Types } from 'mongoose';

import { FollowModel } from '../models/follow.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { UserModel } from '../models/user.model.js';

function asObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error(`Invalid user id: ${id}`);
  }
  return new Types.ObjectId(id);
}

export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  const pair = await followPair(followerId, followingId);
  return pair.aFollowsB;
}

/** One query for both follow directions between two users. */
export async function followPair(
  a: string,
  b: string,
): Promise<{ aFollowsB: boolean; bFollowsA: boolean }> {
  if (!Types.ObjectId.isValid(a) || !Types.ObjectId.isValid(b) || a === b) {
    return { aFollowsB: false, bFollowsA: false };
  }
  const aId = asObjectId(a);
  const bId = asObjectId(b);
  const rows = await FollowModel.find({
    $or: [
      { followerId: aId, followingId: bId },
      { followerId: bId, followingId: aId },
    ],
  })
    .select('followerId followingId')
    .lean();

  let aFollowsB = false;
  let bFollowsA = false;
  for (const row of rows) {
    const from = String(row.followerId);
    const to = String(row.followingId);
    if (from === a && to === b) aFollowsB = true;
    if (from === b && to === a) bFollowsA = true;
  }
  return { aFollowsB, bFollowsA };
}

/** Both users follow each other (DM unlock, private calendar, notification copy). */
export async function areMutualFollowers(a: string, b: string): Promise<boolean> {
  const { aFollowsB, bFollowsA } = await followPair(a, b);
  return aFollowsB && bFollowsA;
}

/** Private calendar/lists stay hidden until the viewer and profile follow each other. */
export function privateProfileHidesContent(
  isOwnProfile: boolean,
  isPrivateProfile: boolean,
  mutualFollow: boolean,
): boolean {
  return !isOwnProfile && isPrivateProfile && !mutualFollow;
}

/**
 * Outbound = people the viewer follows.
 * Inbound = people who follow the viewer.
 */
export async function loadViewerFollowGraph(viewerId: string): Promise<{
  iFollow: Set<string>;
  followsMe: Set<string>;
}> {
  if (!Types.ObjectId.isValid(viewerId)) {
    return { iFollow: new Set(), followsMe: new Set() };
  }
  const viewerOid = asObjectId(viewerId);
  const [outbound, inbound] = await Promise.all([
    FollowModel.find({ followerId: viewerOid }).select('followingId').lean(),
    FollowModel.find({ followingId: viewerOid }).select('followerId').lean(),
  ]);
  return {
    iFollow: new Set(outbound.map((e) => String(e.followingId))),
    followsMe: new Set(inbound.map((e) => String(e.followerId))),
  };
}

/**
 * Lower = higher in RSVP / likes lists.
 * 0 viewer self · 1 I follow · 2 mutual · 3 follows me · 4 everyone else
 */
export function viewerSocialRank(
  targetUserId: string,
  viewerId: string,
  graph: { iFollow: Set<string>; followsMe: Set<string> },
): number {
  if (targetUserId === viewerId) return 0;
  const out = graph.iFollow.has(targetUserId);
  const inn = graph.followsMe.has(targetUserId);
  if (out && !inn) return 1;
  if (out && inn) return 2;
  if (!out && inn) return 3;
  return 4;
}

/** Stable sort by social graph, then optional secondary key (e.g. createdAt). */
export function sortByViewerSocialGraph<T>(
  items: T[],
  viewerId: string,
  graph: { iFollow: Set<string>; followsMe: Set<string> },
  getUserId: (item: T) => string,
  getSecondary: (item: T) => number = () => 0,
): T[] {
  return [...items].sort((a, b) => {
    const ra = viewerSocialRank(getUserId(a), viewerId, graph);
    const rb = viewerSocialRank(getUserId(b), viewerId, graph);
    if (ra !== rb) return ra - rb;
    return getSecondary(a) - getSecondary(b);
  });
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

  const followerObjectId = asObjectId(followerId);
  const followingObjectId = asObjectId(followingId);

  const existing = await FollowModel.findOne({
    followerId: followerObjectId,
    followingId: followingObjectId,
  });

  if (existing) {
    await existing.deleteOne();
    await Promise.all([
      UserModel.updateOne({ _id: followingObjectId }, { $inc: { followersCount: -1 } }),
      UserModel.updateOne({ _id: followerObjectId }, { $inc: { followingCount: -1 } }),
    ]);
    // Floor at 0 if counters ever drifted.
    await Promise.all([
      UserModel.updateOne(
        { _id: followingObjectId, followersCount: { $lt: 0 } },
        { $set: { followersCount: 0 } },
      ),
      UserModel.updateOne(
        { _id: followerObjectId, followingCount: { $lt: 0 } },
        { $set: { followingCount: 0 } },
      ),
    ]);
    const target = await UserModel.findById(followingObjectId).select('followersCount').lean();
    return { following: false, followersCount: clampCount(target?.followersCount) };
  }

  try {
    await FollowModel.create({
      followerId: followerObjectId,
      followingId: followingObjectId,
    });
  } catch (err: unknown) {
    // Race: another request created the same edge — treat as already following.
    const code = (err as { code?: number })?.code;
    if (code !== 11000) throw err;
    const target = await UserModel.findById(followingObjectId).select('followersCount').lean();
    return { following: true, followersCount: clampCount(target?.followersCount) };
  }

  await Promise.all([
    UserModel.updateOne({ _id: followingObjectId }, { $inc: { followersCount: 1 } }),
    UserModel.updateOne({ _id: followerObjectId }, { $inc: { followingCount: 1 } }),
  ]);

  const mutual = await areMutualFollowers(followerId, followingId);
  await NotificationModel.create({
    userId: followingObjectId,
    type: 'follow',
    actorUserId: followerObjectId,
    mutualFollow: mutual,
  });

  const target = await UserModel.findById(followingObjectId).select('followersCount').lean();
  return { following: true, followersCount: clampCount(target?.followersCount) };
}
