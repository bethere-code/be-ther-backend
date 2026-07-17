import { Types } from 'mongoose';

import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import { enrichPostsForViewer } from '../utils/enrich-posts.js';
import { parseEventDateToIso } from '../utils/event-date.js';

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const MONTH_ABBR = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** Escape a string for safe use inside a MongoDB regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Accepts human dates like "22 june 2026", "Jun 22, 2026", "2026-06-22"
 * and returns ISO YYYY-MM-DD when parseable.
 */
export function parseSearchDateQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fromHelper = parseEventDateToIso(trimmed);
  if (fromHelper) return fromHelper;

  // "22 June 2026" / "22 Jun 2026"
  const dayFirst = trimmed.match(
    /^(\d{1,2})\s+([A-Za-z]+)(?:\s+|,\s*)(\d{4})$/,
  );
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const monthRaw = dayFirst[2]!.slice(0, 3).toLowerCase();
    const year = Number(dayFirst[3]);
    const monthIdx = MONTH_ABBR.indexOf(monthRaw as (typeof MONTH_ABBR)[number]);
    if (monthIdx >= 0 && day >= 1 && day <= 31 && year >= 1970) {
      return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // "June 22 2026" (no comma)
  const monthFirst = trimmed.match(
    /^([A-Za-z]+)\s+(\d{1,2})(?:\s+|,\s*)(\d{4})$/,
  );
  if (monthFirst) {
    const monthRaw = monthFirst[1]!.slice(0, 3).toLowerCase();
    const day = Number(monthFirst[2]);
    const year = Number(monthFirst[3]);
    const monthIdx = MONTH_ABBR.indexOf(monthRaw as (typeof MONTH_ABBR)[number]);
    if (monthIdx >= 0 && day >= 1 && day <= 31 && year >= 1970) {
      return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

/** Alternate date strings we might have stored or a user might type. */
function dateSearchVariants(iso: string): string[] {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return [iso];
  const monthIdx = m - 1;
  const monthFull = MONTH_NAMES[monthIdx]!;
  const monthAbbr = MONTH_ABBR[monthIdx]!;
  const day = String(d);
  const dayPad = String(d).padStart(2, '0');

  return [
    iso,
    `${monthAbbr} ${day}, ${y}`,
    `${monthAbbr} ${dayPad}, ${y}`,
    `${monthFull} ${day}, ${y}`,
    `${monthFull} ${dayPad}, ${y}`,
    `${day} ${monthAbbr} ${y}`,
    `${day} ${monthFull} ${y}`,
    `${dayPad} ${monthAbbr} ${y}`,
    `${dayPad} ${monthFull} ${y}`,
  ];
}

export type SearchPostsParams = {
  query: string;
  country?: string;
  viewerId: string;
  skip?: number;
  limit?: number;
};

export type SearchPostsResult = {
  items: Record<string, unknown>[];
  nextSkip: number | null;
};

/**
 * Multi-field event search:
 * event name (location), city (country), description (caption),
 * venue, event date, and creator / artist-style author name.
 */
export async function searchPosts(params: SearchPostsParams): Promise<SearchPostsResult> {
  const query = params.query.trim();
  const skip = Math.max(0, params.skip ?? 0);
  const limit = Math.min(50, Math.max(1, params.limit ?? 10));
  const countryFilter = params.country?.trim();

  if (!query) {
    return { items: [], nextSkip: null };
  }

  const visibility = {
    $or: [{ isPrivate: false }, { authorId: new Types.ObjectId(params.viewerId) }],
  };

  const escaped = escapeRegex(query);
  const textRegex = { $regex: escaped, $options: 'i' as const };

  const fieldMatchers: Record<string, unknown>[] = [
    { location: textRegex },
    { country: textRegex },
    { caption: textRegex },
    { 'eventDetails.venue': textRegex },
    { 'eventDetails.date': textRegex },
  ];

  const isoDate = parseSearchDateQuery(query);
  if (isoDate) {
    for (const variant of dateSearchVariants(isoDate)) {
      fieldMatchers.push({
        'eventDetails.date': {
          $regex: escapeRegex(variant),
          $options: 'i',
        },
      });
    }
    // Exact ISO match (common storage format from create-post)
    fieldMatchers.push({ 'eventDetails.date': isoDate });
  }

  // Creator / artist-style match on author username + displayName
  const matchingAuthors = await UserModel.find({
    $or: [{ username: textRegex }, { displayName: textRegex }],
  })
    .select('_id')
    .limit(50)
    .lean();

  if (matchingAuthors.length > 0) {
    fieldMatchers.push({
      authorId: { $in: matchingAuthors.map((u) => u._id) },
    });
  }

  const filter: Record<string, unknown> = {
    $and: [visibility, { $or: fieldMatchers }],
  };

  if (countryFilter) {
    filter.$and = [
      ...(filter.$and as Record<string, unknown>[]),
      { country: { $regex: escapeRegex(countryFilter), $options: 'i' } },
    ];
  }

  const posts = await PostModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit + 1)
    .populate('authorId', 'username displayName avatarUrl starsReceived')
    .lean();

  const page = posts.slice(0, limit);
  const hasMore = posts.length > limit;
  const enriched = await enrichPostsForViewer(page as never[], params.viewerId);

  return {
    items: enriched as Record<string, unknown>[],
    nextSkip: hasMore ? skip + limit : null,
  };
}
