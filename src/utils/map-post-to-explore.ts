/** Maps an enriched feed post into the explore grid / sheet shape. */
export function mapPostToExploreItem(post: Record<string, unknown>): Record<string, unknown> {
  const eventDetails = post.eventDetails as Record<string, unknown> | undefined;
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

  return {
    _id: String(post._id),
    postId: String(post._id),
    source: 'post',
    title: location,
    location: country.length > 0 ? country : location,
    country,
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
  };
}
