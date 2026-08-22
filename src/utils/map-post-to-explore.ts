import { isPostEventPast } from './event-date.js';

export type EventLocationFields = {
  placeId?: string;
  name?: string;
  formattedAddress?: string;
  locality?: string;
  street?: string;
  area?: string;
  city?: string;
  district?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  lat?: number;
  lng?: number;
};

function trimStr(value: unknown): string {
  return String(value ?? '').trim();
}

/** Stable author payload for explore / search clients (never a raw ObjectId). */
export function mapExploreAuthor(authorId: unknown): Record<string, unknown> | null {
  if (authorId && typeof authorId === 'object' && authorId !== null && 'username' in authorId) {
    const a = authorId as Record<string, unknown>;
    const username = trimStr(a.username);
    if (!username) return null;
    return {
      _id: String(a._id ?? a.id ?? ''),
      username,
      displayName: trimStr(a.displayName) || username,
      avatarUrl: trimStr(a.avatarUrl),
      badge: a.badge ?? null,
    };
  }
  return null;
}

/**
 * Places `formattedAddress` only — no venue/country stitching.
 */
export function resolvePostEventAddress(post: Record<string, unknown>): string {
  const eventDetails = post.eventDetails as Record<string, unknown> | undefined;
  const eventLocation = eventDetails?.eventLocation as EventLocationFields | undefined;
  return trimStr(eventLocation?.formattedAddress);
}

/** Maps an enriched feed post into the explore grid / sheet shape. */
export function mapPostToExploreItem(post: Record<string, unknown>): Record<string, unknown> {
  const eventDetails = post.eventDetails as Record<string, unknown> | undefined;
  const eventLocation = (eventDetails?.eventLocation ?? null) as EventLocationFields | null;
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

  const country = trimStr(eventLocation?.country) || trimStr(post.country);
  const venue = trimStr(eventDetails?.venue) || trimStr(eventLocation?.name);
  const address = resolvePostEventAddress(post);
  const author = mapExploreAuthor(post.author ?? post.authorId);

  return {
    _id: String(post._id),
    postId: String(post._id),
    source: 'post',
    title: location,
    location: address || location,
    country,
    place: address || null,
    address: address || null,
    // Pass through so clients can render the exact Places payload.
    eventLocation: eventLocation
      ? {
          placeId: trimStr(eventLocation.placeId) || undefined,
          name: trimStr(eventLocation.name) || undefined,
          formattedAddress: trimStr(eventLocation.formattedAddress) || undefined,
          locality: trimStr(eventLocation.locality) || undefined,
          street: trimStr(eventLocation.street) || undefined,
          area: trimStr(eventLocation.area) || undefined,
          city: trimStr(eventLocation.city) || undefined,
          district: trimStr(eventLocation.district) || undefined,
          state: trimStr(eventLocation.state) || undefined,
          country: trimStr(eventLocation.country) || undefined,
          postalCode: trimStr(eventLocation.postalCode) || undefined,
          lat: eventLocation.lat,
          lng: eventLocation.lng,
        }
      : null,
    image: String(post.imageUrl ?? ''),
    date,
    venue,
    ticketUrl: eventDetails?.ticketUrl ?? null,
    time: eventDetails?.time ?? null,
    attendees: Math.max(0, Number(post.calendarCount ?? 0) || 0),
    trending: likesCount >= 5,
    type: eventDetails?.type ?? 'event',
    status: post.status,
    caption: post.caption ?? '',
    viewCount: Math.max(0, Number(post.viewCount ?? 0) || 0),
    calendarCount: Math.max(0, Number(post.calendarCount ?? 0) || 0),
    likesCount: Math.max(0, likesCount || 0),
    commentsCount: Math.max(0, Number(post.commentsCount ?? 0) || 0),
    authorId: author,
    author,
    liked: post.liked ?? false,
    bookmarked: post.bookmarked ?? false,
    inCalendar: post.inCalendar ?? false,
    calendarStatus: post.calendarStatus ?? (post.inCalendar ? 'going' : null),
    isPast,
  };
}
