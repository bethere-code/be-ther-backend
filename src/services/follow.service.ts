import { Types } from 'mongoose';

import { BlockModel } from '../models/block.model.js';
import { FollowModel, acceptedOnly } from '../models/follow.model.js';
import { NotificationModel } from '../models/notification.model.js';
import { UserModel } from '../models/user.model.js';
import { createAndPushNotification } from './notification.service.js';

function asObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error(`Invalid user id: ${id}`);
  }
  return new Types.ObjectId(id);
}

function isAcceptedStatus(status: unknown): boolean {
  return status !== 'pending';
}

export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  const pair = await followPair(followerId, followingId);
  return pair.aFollowsB;
}

/** Viewer has a pending request to follow target (not yet accepted). */
export async function hasPendingFollowRequest(
  followerId: string,
  followingId: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(followerId) || !Types.ObjectId.isValid(followingId)) {
    return false;
  }
  const row = await FollowModel.exists({
    followerId: asObjectId(followerId),
    followingId: asObjectId(followingId),
    status: 'pending',
  });
  return Boolean(row);
}

/** One query for both follow directions between two users (accepted only). */
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
    .select('followerId followingId status')
    .lean();

  let aFollowsB = false;
  let bFollowsA = false;
  for (const row of rows) {
    if (!isAcceptedStatus(row.status)) continue;
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

/** Private calendar/lists stay hidden until the viewer follows the profile. */
export function privateProfileHidesContent(
  isOwnProfile: boolean,
  isPrivateProfile: boolean,
  viewerFollows: boolean,
): boolean {
  return !isOwnProfile && isPrivateProfile && !viewerFollows;
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
    FollowModel.find(acceptedOnly({ followerId: viewerOid })).select('followingId').lean(),
    FollowModel.find(acceptedOnly({ followingId: viewerOid })).select('followerId').lean(),
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

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(a) || !Types.ObjectId.isValid(b) || a === b) return false;
  const aId = asObjectId(a);
  const bId = asObjectId(b);
  const row = await BlockModel.exists({
    $or: [
      { blockerId: aId, blockedId: bId },
      { blockerId: bId, blockedId: aId },
    ],
  });
  return Boolean(row);
}

async function clearFollowRequestNotifications(
  privateUserId: Types.ObjectId,
  actorUserId: Types.ObjectId,
): Promise<void> {
  await NotificationModel.deleteMany({
    userId: privateUserId,
    actorUserId,
    type: 'follow_request',
  });
}

/** Replace the pending request alert with outcome rows for owner (+ requester on accept). */
async function recordFollowRequestOutcome(
  privateUserId: Types.ObjectId,
  requesterUserId: Types.ObjectId,
  action: 'accept' | 'reject',
): Promise<void> {
  await clearFollowRequestNotifications(privateUserId, requesterUserId);

  if (action === 'reject') {
    await createAndPushNotification({
      userId: privateUserId,
      type: 'follow_request_rejected_owner',
      actorUserId: requesterUserId,
      mutualFollow: false,
    });
    return;
  }

  await Promise.all([
    createAndPushNotification({
      userId: privateUserId,
      type: 'follow_request_accepted_owner',
      actorUserId: requesterUserId,
      mutualFollow: false,
    }),
    createAndPushNotification({
      userId: requesterUserId,
      type: 'follow_request_accepted',
      actorUserId: privateUserId,
      mutualFollow: false,
    }),
  ]);
}

/** Drops one follow edge. Counters only move for accepted edges. */
export async function deleteFollowEdge(followerId: string, followingId: string): Promise<boolean> {
  const followerObjectId = asObjectId(followerId);
  const followingObjectId = asObjectId(followingId);
  const existing = await FollowModel.findOne({
    followerId: followerObjectId,
    followingId: followingObjectId,
  });
  if (!existing) return false;
  const wasAccepted = isAcceptedStatus(existing.status);
  await existing.deleteOne();
  await clearFollowRequestNotifications(followingObjectId, followerObjectId);
  if (!wasAccepted) return true;

  await Promise.all([
    UserModel.updateOne({ _id: followingObjectId }, { $inc: { followersCount: -1 } }),
    UserModel.updateOne({ _id: followerObjectId }, { $inc: { followingCount: -1 } }),
  ]);
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
  return true;
}

export type ToggleFollowResult = {
  following: boolean;
  requested: boolean;
  followersCount: number;
};

/**
 * Toggle follow / request. Private targets get a pending request (no counters).
 */
export async function toggleFollow(
  followerId: string,
  followingId: string,
): Promise<ToggleFollowResult> {
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
    await deleteFollowEdge(followerId, followingId);
    const target = await UserModel.findById(followingObjectId).select('followersCount').lean();
    return {
      following: false,
      requested: false,
      followersCount: clampCount(target?.followersCount),
    };
  }

  if (await isBlockedEitherWay(followerId, followingId)) {
    throw new Error('BLOCKED');
  }

  const targetUser = await UserModel.findById(followingObjectId)
    .select('followersCount settings.isPrivateProfile')
    .lean();
  if (!targetUser) {
    throw new Error('USER_NOT_FOUND');
  }

  const isPrivate = Boolean(
    targetUser.settings &&
      typeof targetUser.settings === 'object' &&
      (targetUser.settings as { isPrivateProfile?: boolean }).isPrivateProfile,
  );

  if (isPrivate) {
    try {
      await FollowModel.create({
        followerId: followerObjectId,
        followingId: followingObjectId,
        status: 'pending',
      });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code !== 11000) throw err;
    }
    await createAndPushNotification({
      userId: followingObjectId,
      type: 'follow_request',
      actorUserId: followerObjectId,
      mutualFollow: false,
    });
    return {
      following: false,
      requested: true,
      followersCount: clampCount(targetUser.followersCount),
    };
  }

  try {
    await FollowModel.create({
      followerId: followerObjectId,
      followingId: followingObjectId,
      status: 'accepted',
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code !== 11000) throw err;
    const target = await UserModel.findById(followingObjectId).select('followersCount').lean();
    return {
      following: true,
      requested: false,
      followersCount: clampCount(target?.followersCount),
    };
  }

  await Promise.all([
    UserModel.updateOne({ _id: followingObjectId }, { $inc: { followersCount: 1 } }),
    UserModel.updateOne({ _id: followerObjectId }, { $inc: { followingCount: 1 } }),
  ]);

  const mutual = await areMutualFollowers(followerId, followingId);
  await createAndPushNotification({
    userId: followingObjectId,
    type: 'follow',
    actorUserId: followerObjectId,
    mutualFollow: mutual,
  });

  const target = await UserModel.findById(followingObjectId).select('followersCount').lean();
  return {
    following: true,
    requested: false,
    followersCount: clampCount(target?.followersCount),
  };
}

/**
 * Private account owner accepts or rejects a pending follow request.
 * `privateUserId` must be the followingId (the private account).
 */
export async function respondFollowRequest(
  privateUserId: string,
  requesterId: string,
  action: 'accept' | 'reject',
): Promise<{ accepted: boolean; followersCount: number }> {
  if (privateUserId === requesterId) {
    throw new Error('CANNOT_FOLLOW_SELF');
  }

  const privateOid = asObjectId(privateUserId);
  const requesterOid = asObjectId(requesterId);

  const edge = await FollowModel.findOne({
    followerId: requesterOid,
    followingId: privateOid,
    status: 'pending',
  });
  if (!edge) {
    throw new Error('NO_PENDING_REQUEST');
  }

  if (action === 'reject') {
    await edge.deleteOne();
    await recordFollowRequestOutcome(privateOid, requesterOid, 'reject');
    const target = await UserModel.findById(privateOid).select('followersCount').lean();
    return { accepted: false, followersCount: clampCount(target?.followersCount) };
  }

  edge.status = 'accepted';
  await edge.save();

  await Promise.all([
    UserModel.updateOne({ _id: privateOid }, { $inc: { followersCount: 1 } }),
    UserModel.updateOne({ _id: requesterOid }, { $inc: { followingCount: 1 } }),
  ]);

  await recordFollowRequestOutcome(privateOid, requesterOid, 'accept');

  const target = await UserModel.findById(privateOid).select('followersCount').lean();
  return { accepted: true, followersCount: clampCount(target?.followersCount) };
}

export async function setBlock(
  blockerId: string,
  blockedId: string,
  blocked: boolean,
): Promise<{ blocked: boolean; followersCount: number }> {
  if (blockerId === blockedId) throw new Error('CANNOT_BLOCK_SELF');
  const blocker = asObjectId(blockerId);
  const other = asObjectId(blockedId);

  if (!blocked) {
    await BlockModel.deleteOne({ blockerId: blocker, blockedId: other });
    const target = await UserModel.findById(other).select('followersCount').lean();
    return { blocked: false, followersCount: clampCount(target?.followersCount) };
  }

  try {
    await BlockModel.create({ blockerId: blocker, blockedId: other });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code !== 11000) throw err;
  }

  await Promise.all([
    deleteFollowEdge(blockerId, blockedId),
    deleteFollowEdge(blockedId, blockerId),
  ]);

  const target = await UserModel.findById(other).select('followersCount').lean();
  return { blocked: true, followersCount: clampCount(target?.followersCount) };
}
