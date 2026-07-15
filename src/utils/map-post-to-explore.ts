import { isPostEventPast } from './event-date.js';

/** Maps an enriched feed post into the explore grid / sheet shape. */
export function mapPostToExploreItem(post: Record<string, unknown>): Record<string, unknown> {
  const eventDetails = post.eventDetails as Record<string, unknown> | undefined;
  const isPast = (post.isEventPast as boolean | undefined) ?? isPostEventPast(post as never);
  const likesCount = Number(post.likesCount ?? 0);
  const location = String(post.location ?? '');
  const createdAt = post.createdAt;

  let date = '';
  if (eventDetails?.date) {
    date = String(eventDetails.date);
  } else if (createdAt) {
    const d = new Date(createdAt as string | Date);
    if (!Number.isNaN(d.getTime())) {
      date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }

  const country = String(post.country ?? '').trim();
  const venue = String(eventDetails?.venue ?? '').trim();
  // Prefer country, then venue (when it isn't just a copy of the event title).
  let place = country;
  if (!place && venue && venue.toLowerCase() !== location.toLowerCase()) {
    place = venue;
  } else if (!place) {
    place = venue;
  }

  return {
    _id: String(post._id),
    postId: String(post._id),
    source: 'post',
    title: location,
    // Keep `location` as place-or-title for older clients; prefer `place` / `country`.
    location: place || location,
    country,
    place: place || null,
    image: String(post.imageUrl ?? ''),
    date,
    venue,
    ticketUrl: eventDetails?.ticketUrl ?? null,
    time: eventDetails?.time ?? null,
    attendees: likesCount,
    trending: likesCount >= 5,
    type: eventDetails?.type ?? 'event',
    status: post.status,
    caption: post.caption ?? '',
    authorId: post.authorId,
    liked: post.liked ?? false,
    bookmarked: post.bookmarked ?? false,
    inCalendar: post.inCalendar ?? false,
    isPast,
  };
}
