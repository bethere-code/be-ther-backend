import { Types } from 'mongoose';

import { FollowModel } from '../models/follow.model.js';
import { UserModel } from '../models/user.model.js';

/**
 * Feed / explore / search: public events from public accounts, plus
 * public events from private accounts the viewer follows, plus own posts
 * (including private events).
 */
export function postsListFilterFromSets(
  viewerId: string,
  followingIds: Iterable<string>,
  privateAuthorIds: Iterable<string>,
): Record<string, unknown> {
  const viewer = new Types.ObjectId(viewerId);
  const following = new Set(followingIds);
  const hide: Types.ObjectId[] = [];
  for (const id of privateAuthorIds) {
    if (id === viewerId || following.has(id)) continue;
    if (Types.ObjectId.isValid(id)) hide.push(new Types.ObjectId(id));
  }
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
  const [following, privateAuthors] = await Promise.all([
    FollowModel.find({ followerId: viewer }).select('followingId').lean(),
    UserModel.find({ 'settings.isPrivateProfile': true }).select('_id').lean(),
  ]);
  return postsListFilterFromSets(
    viewerId,
    following.map((f) => String(f.followingId)),
    privateAuthors.map((u) => String(u._id)),
  );
}

/** Single post: own always; private event = author only; private profile = followers. */
export async function canViewerSeePost(
  post: { authorId: unknown; isPrivate?: boolean },
  viewerId: string,
): Promise<boolean> {
  const authorId = String(post.authorId);
  if (authorId === viewerId) return true;
  if (post.isPrivate) return false;
  const author = await UserModel.findById(authorId).select('settings.isPrivateProfile').lean();
  if (!author?.settings?.isPrivateProfile) return true;
  const follows = await FollowModel.exists({
    followerId: new Types.ObjectId(viewerId),
    followingId: new Types.ObjectId(authorId),
  });
  return Boolean(follows);
}
