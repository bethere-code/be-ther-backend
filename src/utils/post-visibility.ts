import { Types } from 'mongoose';

import { BlockModel } from '../models/block.model.js';
import { FollowModel } from '../models/follow.model.js';
import { UserModel } from '../models/user.model.js';
import { isBlockedEitherWay } from '../services/follow.service.js';

/**
 * Feed / explore / search: public events from public accounts, plus
 * public events from private accounts the viewer follows, plus own posts
 * (including private events). Blocked authors are always hidden.
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

export async function postsVisibleToViewerFilter(
  viewerId: string,
): Promise<Record<string, unknown>> {
  const viewer = new Types.ObjectId(viewerId);
  const [following, privateAuthors, blocks] = await Promise.all([
    FollowModel.find({ followerId: viewer }).select('followingId').lean(),
    UserModel.find({ 'settings.isPrivateProfile': true }).select('_id').lean(),
    BlockModel.find({
      $or: [{ blockerId: viewer }, { blockedId: viewer }],
    })
      .select('blockerId blockedId')
      .lean(),
  ]);
  const extraHidden = blocks.map((row) =>
    String(row.blockerId) === viewerId ? String(row.blockedId) : String(row.blockerId),
  );
  return postsListFilterFromSets(
    viewerId,
    following.map((f) => String(f.followingId)),
    privateAuthors.map((u) => String(u._id)),
    extraHidden,
  );
}

/** Single post: own always; private event = author only; private profile = followers. */
export async function canViewerSeePost(
  post: { authorId: unknown; isPrivate?: boolean },
  viewerId: string,
): Promise<boolean> {
  const authorId = String(post.authorId);
  if (authorId === viewerId) return true;
  if (await isBlockedEitherWay(viewerId, authorId)) return false;
  if (post.isPrivate) return false;
  const author = await UserModel.findById(authorId).select('settings.isPrivateProfile').lean();
  if (!author?.settings?.isPrivateProfile) return true;
  const follows = await FollowModel.exists({
    followerId: new Types.ObjectId(viewerId),
    followingId: new Types.ObjectId(authorId),
  });
  return Boolean(follows);
}
