import { Types } from 'mongoose';

import { BookmarkModel } from '../models/bookmark.model.js';
import { CalendarModel } from '../models/calendar.model.js';
import { ExploreBookmarkModel } from '../models/explore-bookmark.model.js';
import { LikeModel } from '../models/like.model.js';
import { computeMemberBadge } from './event-date.js';

type PopulatedAuthor = {
  _id?: Types.ObjectId;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  starsReceived?: number;
};

type LeanPost = Record<string, unknown> & {
  _id: Types.ObjectId;
  authorId?: PopulatedAuthor | Types.ObjectId;
};

function enrichAuthor(authorRaw: PopulatedAuthor | Types.ObjectId | undefined): PopulatedAuthor & { badge: ReturnType<typeof computeMemberBadge> } {
  if (!authorRaw || authorRaw instanceof Types.ObjectId) {
    return {
      username: '',
      displayName: '',
      avatarUrl: '',
      badge: null,
    };
  }
  const starsReceived = Number(authorRaw.starsReceived ?? 0);
  return {
    ...authorRaw,
    badge: computeMemberBadge(starsReceived),
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
    CalendarModel.find({ userId: viewerId, postId: { $in: objectIds } }).select('postId').lean(),
  ]);

  const likedSet = new Set(likes.map((l) => String(l.postId)));
  const bookmarkedSet = new Set(bookmarks.map((b) => String(b.postId)));
  const calendarSet = new Set(calendars.map((c) => String(c.postId)));

  return posts.map((post) => {
    const id = String(post._id);
    const author = enrichAuthor(post.authorId as PopulatedAuthor | Types.ObjectId | undefined);
    return {
      ...post,
      authorId: author,
      liked: likedSet.has(id),
      bookmarked: bookmarkedSet.has(id),
      inCalendar: calendarSet.has(id),
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
