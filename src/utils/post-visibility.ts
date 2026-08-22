import { Types } from 'mongoose';

import { BlockModel } from '../models/block.model.js';
import { FollowModel, acceptedOnly } from '../models/follow.model.js';
import { ProfileCalendarHiddenModel } from '../models/profile-calendar-hidden.model.js';
import { UserModel } from '../models/user.model.js';
import { isBlockedEitherWay } from '../services/follow.service.js';
import { resolvePostAuthorId } from './post-author-id.js';

/**
 * Feed / explore / search: public events from public accounts, plus
 * public events from private accounts the viewer follows, plus own posts
 * (including private events). Blocked authors and author-hidden profile
 * events are always excluded. Share links use GET /posts/:id instead.
 */
export function postsListFilterFromSets(
  viewerId: string,
  followingIds: Iterable<string>,
  privateAuthorIds: Iterable<string>,
  extraHiddenAuthorIds: Iterable<string> = [],
): Record<string, unknown> {
  const viewer = new Types.ObjectId(viewerId);
  const following = new Set(followingIds);
  const hide: Types.ObjectId[] = [];
  const seen = new Set<string>();
  const pushHide = (id: string) => {
    if (id === viewerId || seen.has(id) || !Types.ObjectId.isValid(id)) return;
    seen.add(id);
    hide.push(new Types.ObjectId(id));
  };
  for (const id of privateAuthorIds) {
    if (following.has(id)) continue;
    pushHide(id);
  }
  for (const id of extraHiddenAuthorIds) pushHide(id);
  const eventOk: Record<string, unknown> = {
    $or: [{ isPrivate: false }, { authorId: viewer }],
  };
  if (hide.length === 0) return eventOk;
  return { $and: [eventOk, { authorId: { $nin: hide } }] };
}

/** Posts the author hid from their profile — excluded from feed/explore/search for everyone. */
export async function authorHiddenFromDiscoveryPostIds(): Promise<Types.ObjectId[]> {
  const rows = await ProfileCalendarHiddenModel.aggregate<{ _id: Types.ObjectId }>([
    {
      $lookup: {
        from: 'posts',
        localField: 'postId',
        foreignField: '_id',
        as: 'post',
        pipeline: [{ $project: { authorId: 1 } }],
      },
    },
    { $unwind: '$post' },
    { $match: { $expr: { $eq: ['$profileUserId', '$post.authorId'] } } },
    { $project: { _id: '$postId' } },
  ]);
  return rows.map((row) => row._id);
}

export async function postsVisibleToViewerFilter(
  viewerId: string,
): Promise<Record<string, unknown>> {
  const viewer = new Types.ObjectId(viewerId);
  const [following, privateAuthors, blocks, hiddenPostIds] = await Promise.all([
    FollowModel.find(acceptedOnly({ followerId: viewer })).select('followingId').lean(),
    UserModel.find({ 'settings.isPrivateProfile': true }).select('_id').lean(),
    BlockModel.find({
      $or: [{ blockerId: viewer }, { blockedId: viewer }],
    })
      .select('blockerId blockedId')
      .lean(),
    authorHiddenFromDiscoveryPostIds(),
  ]);
  const extraHidden = blocks.map((row) =>
    String(row.blockerId) === viewerId ? String(row.blockedId) : String(row.blockerId),
  );
  const base = postsListFilterFromSets(
    viewerId,
    following.map((f) => String(f.followingId)),
    privateAuthors.map((u) => String(u._id)),
    extraHidden,
  );
  if (hiddenPostIds.length === 0) return base;
  return { $and: [base, { _id: { $nin: hiddenPostIds } }] };
}

/** Single post: own always; private event = author only; private profile = followers. */
export async function canViewerSeePost(
  post: { authorId: unknown; isPrivate?: boolean },
  viewerId: string,
): Promise<boolean> {
  const authorId = resolvePostAuthorId(post.authorId);
  if (!authorId) return false;
  if (authorId === viewerId) return true;
  if (await isBlockedEitherWay(viewerId, authorId)) return false;
  if (post.isPrivate) return false;
  const author = await UserModel.findById(authorId).select('settings.isPrivateProfile').lean();
  if (!author?.settings?.isPrivateProfile) return true;
  const follows = await FollowModel.exists(
    acceptedOnly({
      followerId: new Types.ObjectId(viewerId),
      followingId: new Types.ObjectId(authorId),
    }),
  );
  return Boolean(follows);
}
