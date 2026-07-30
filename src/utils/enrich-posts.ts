import { Types } from 'mongoose';

import { BookmarkModel } from '../models/bookmark.model.js';
import { CalendarModel } from '../models/calendar.model.js';
import { ExploreBookmarkModel } from '../models/explore-bookmark.model.js';
import { LikeModel } from '../models/like.model.js';
import { PostModel } from '../models/post.model.js';
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
  authorRaw: PopulatedAuthor | Types.ObjectId | undefined,
): PopulatedAuthor & { badge: null } {
  if (!authorRaw || authorRaw instanceof Types.ObjectId) {
    return {
      username: '',
      displayName: '',
      avatarUrl: '',
      // badge: paused
      badge: null,
    };
  }
  return {
    ...authorRaw,
    // badge: paused — restore with multi-signal computeMemberBadge later
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
    CalendarModel.find({ userId: viewerId, postId: { $in: objectIds } }).select('postId').lean(),
  ]);

  const likedSet = new Set(likes.map((l) => String(l.postId)));
  const bookmarkedSet = new Set(bookmarks.map((b) => String(b.postId)));
  const calendarSet = new Set(calendars.map((c) => String(c.postId)));

  // Heal older own posts created before "author always on calendar" —
  // upsert calendar rows so attendees count / sheet stay accurate.
  const healedCalendarCounts = new Map<string, number>();
  for (const post of posts) {
    const id = String(post._id);
    const authorRaw = post.authorId as PopulatedAuthor | Types.ObjectId | undefined;
    const authorId =
      authorRaw && typeof authorRaw === 'object' && '_id' in authorRaw && authorRaw._id
        ? String(authorRaw._id)
        : authorRaw != null
          ? String(authorRaw)
          : '';
    if (!authorId || authorId !== viewerId || calendarSet.has(id)) continue;

    try {
      await CalendarModel.create({
        postId: post._id,
        userId: new Types.ObjectId(viewerId),
      });
      await PostModel.updateOne({ _id: post._id }, { $inc: { calendarCount: 1 } });
      const prev = typeof post.calendarCount === 'number' ? post.calendarCount : 0;
      healedCalendarCounts.set(id, prev + 1);
      calendarSet.add(id);
    } catch {
      // Duplicate key / race — treat as already on calendar.
      calendarSet.add(id);
    }
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
    return {
      ...post,
      ...(healedCalendarCounts.has(id) ? { calendarCount: healedCalendarCounts.get(id) } : {}),
      authorId: author,
      liked: likedSet.has(id),
      bookmarked: bookmarkedSet.has(id),
      // Own events are always on the author's calendar.
      inCalendar: isOwn || calendarSet.has(id),
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
