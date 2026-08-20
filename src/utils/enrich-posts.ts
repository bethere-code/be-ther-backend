import { Types } from 'mongoose';

import { BookmarkModel } from '../models/bookmark.model.js';
import { CalendarModel } from '../models/calendar.model.js';
import { ExploreBookmarkModel } from '../models/explore-bookmark.model.js';
import { LikeModel } from '../models/like.model.js';
import { isPostEventPast } from './event-date.js';

type PopulatedAuthor = {
  _id?: Types.ObjectId;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
};

type LeanPost = Record<string, unknown> & {
  _id: Types.ObjectId;
  authorId?: PopulatedAuthor | Types.ObjectId;
};

function enrichAuthor(
  authorRaw: PopulatedAuthor | Types.ObjectId | string | undefined,
): PopulatedAuthor & { badge: null } {
  // Lean + JSON paths: populated authors are plain objects with username.
  // Raw ObjectIds / id strings must not be spread (they have no username).
  if (
    authorRaw &&
    typeof authorRaw === 'object' &&
    !(authorRaw instanceof Types.ObjectId) &&
    'username' in authorRaw
  ) {
    return {
      ...authorRaw,
      // badge: paused — restore with multi-signal computeMemberBadge later
      badge: null,
    };
  }
  const id =
    authorRaw instanceof Types.ObjectId || typeof authorRaw === 'string'
      ? String(authorRaw)
      : '';
  return {
    ...(id ? { _id: id as unknown as Types.ObjectId } : {}),
    username: '',
    displayName: '',
    avatarUrl: '',
    badge: null,
  };
}

export async function enrichPostsForViewer(
  posts: LeanPost[],
  viewerId: string,
): Promise<Record<string, unknown>[]> {
  if (posts.length === 0) return [];

  const postIds = posts
    .map((p) => String(p._id))
    .filter((id) => Types.ObjectId.isValid(id));
  const objectIds = postIds.map((id) => new Types.ObjectId(id));

  const [likes, bookmarks, calendars] = await Promise.all([
    LikeModel.find({ userId: viewerId, postId: { $in: objectIds } }).select('postId').lean(),
    BookmarkModel.find({ userId: viewerId, postId: { $in: objectIds } }).select('postId').lean(),
    CalendarModel.find({ userId: viewerId, postId: { $in: objectIds } })
      .select('postId status')
      .lean(),
  ]);

  const likedSet = new Set(likes.map((l) => String(l.postId)));
  const bookmarkedSet = new Set(bookmarks.map((b) => String(b.postId)));
  const calendarStatusByPost = new Map<string, 'interested' | 'going'>();
  for (const c of calendars) {
    const status = c.status === 'interested' ? 'interested' : 'going';
    calendarStatusByPost.set(String(c.postId), status);
  }

  return posts.map((post) => {
    const id = String(post._id);
    const author = enrichAuthor(post.authorId as PopulatedAuthor | Types.ObjectId | undefined);
    const authorId =
      author._id != null
        ? String(author._id)
        : post.authorId instanceof Types.ObjectId
          ? String(post.authorId)
          : '';
    const isOwn = authorId === viewerId;
    const fromCalendar = calendarStatusByPost.get(id);
    const fromPost =
      post.status === 'interested' || post.status === 'going'
        ? (post.status as 'interested' | 'going')
        : ('going' as const);
    const calendarStatus = isOwn
      ? (fromCalendar ?? fromPost)
      : (fromCalendar ?? null);
    return {
      ...post,
      authorId: author,
      liked: likedSet.has(id),
      bookmarked: bookmarkedSet.has(id),
      // Own events are always on the author's calendar (row or post.status).
      inCalendar: calendarStatus != null,
      calendarStatus,
      isEventPast: isPostEventPast(post as Parameters<typeof isPostEventPast>[0]),
    };
  });
}

export async function enrichExploreEventsForViewer(
  events: Record<string, unknown>[],
  viewerId: string,
): Promise<Record<string, unknown>[]> {
  if (events.length === 0) return [];

  const eventIds = events
    .map((e) => String(e._id))
    .filter((id) => Types.ObjectId.isValid(id));
  const objectIds = eventIds.map((id) => new Types.ObjectId(id));

  const bookmarks = await ExploreBookmarkModel.find({
    userId: viewerId,
    exploreEventId: { $in: objectIds },
  })
    .select('exploreEventId')
    .lean();

  const bookmarkedSet = new Set(bookmarks.map((b) => String(b.exploreEventId)));

  return events.map((event) => ({
    ...event,
    bookmarked: bookmarkedSet.has(String(event._id)),
  }));
}
