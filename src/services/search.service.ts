import { Types } from 'mongoose';

import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import { enrichPostsForViewer } from '../utils/enrich-posts.js';
import { isPostEventPast, parseEventDateToIso } from '../utils/event-date.js';

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

/** Match priority — higher wins. Past events are always pushed below. */
const SCORE = {
  EVENT_NAME: 4000,
  DESCRIPTION: 3000,
  PLACE: 2000,
  AUTHOR: 500,
  DATE: 1000,
  PAST_PENALTY: 100_000,
} as const;

const MAX_CANDIDATES = 400;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsInsensitive(haystack: unknown, needle: string): boolean {
  if (typeof haystack !== 'string' || !haystack.trim() || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
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

  const dayFirst = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)(?:\s+|,\s*)(\d{4})$/);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const monthRaw = dayFirst[2]!.slice(0, 3).toLowerCase();
    const year = Number(dayFirst[3]);
    const monthIdx = MONTH_ABBR.indexOf(monthRaw as (typeof MONTH_ABBR)[number]);
    if (monthIdx >= 0 && day >= 1 && day <= 31 && year >= 1970) {
      return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const monthFirst = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s+|,\s*)(\d{4})$/);
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

function dateFieldMatches(
  dateRaw: unknown,
  query: string,
  iso: string | null,
  variants: string[],
): boolean {
  if (typeof dateRaw !== 'string' || !dateRaw.trim()) return false;
  if (containsInsensitive(dateRaw, query)) return true;
  if (iso && (dateRaw === iso || dateRaw.startsWith(iso))) return true;
  const lower = dateRaw.toLowerCase();
  return variants.some((v) => lower.includes(v.toLowerCase()));
}

type ScoredPost = Record<string, unknown> & {
  _id: Types.ObjectId;
  createdAt?: Date | string;
};

function authorIdOf(post: Record<string, unknown>): string {
  const author = post.authorId;
  if (!author) return '';
  if (typeof author === 'object' && author !== null && '_id' in author) {
    return String((author as { _id: unknown })._id);
  }
  return String(author);
}

/**
 * Ranking:
 * 1. Event name (DB `location`)
 * 2. Description (`caption`)
 * 3. Place (`country` / venue)
 * 4. Date
 * Past events always sink below upcoming, regardless of match field.
 */
export function scoreSearchHit(
  post: Record<string, unknown>,
  query: string,
  opts: {
    isoDate: string | null;
    dateVariants: string[];
    authorIds: Set<string>;
  },
): number {
  const q = query.trim();
  const details = post.eventDetails as { venue?: string; date?: string } | undefined;

  let match = 0;
  // 1 — event name / title
  if (containsInsensitive(post.location, q)) {
    match = Math.max(match, SCORE.EVENT_NAME);
  }
  // 2 — description
  if (containsInsensitive(post.caption, q)) {
    match = Math.max(match, SCORE.DESCRIPTION);
  }
  // 3 — city / venue (place)
  if (containsInsensitive(post.country, q) || containsInsensitive(details?.venue, q)) {
    match = Math.max(match, SCORE.PLACE);
  }
  // 4 — date
  if (dateFieldMatches(details?.date, q, opts.isoDate, opts.dateVariants)) {
    match = Math.max(match, SCORE.DATE);
  }
  // Author / artist-style (kept, below place)
  if (opts.authorIds.has(authorIdOf(post))) {
    match = Math.max(match, SCORE.AUTHOR);
  }

  const past = isPostEventPast(post as Parameters<typeof isPostEventPast>[0]);
  return past ? match - SCORE.PAST_PENALTY : match;
}

function createdAtMs(post: ScoredPost): number {
  if (!post.createdAt) return 0;
  const t = new Date(post.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
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
 * Multi-field event search with priority ranking.
 * Event name > description > place > date; past events always last.
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
  const dateVariants = isoDate ? dateSearchVariants(isoDate) : [];
  if (isoDate) {
    for (const variant of dateVariants) {
      fieldMatchers.push({
        'eventDetails.date': {
          $regex: escapeRegex(variant),
          $options: 'i',
        },
      });
    }
    fieldMatchers.push({ 'eventDetails.date': isoDate });
  }

  const matchingAuthors = await UserModel.find({
    $or: [{ username: textRegex }, { displayName: textRegex }],
  })
    .select('_id')
    .limit(50)
    .lean();

  const authorIds = new Set(matchingAuthors.map((u) => String(u._id)));
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

  // Pull a candidate pool, rank in memory, then page — skip before rank would break priority.
  const candidates = (await PostModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_CANDIDATES)
    .populate('authorId', 'username displayName avatarUrl starsReceived')
    .lean()) as ScoredPost[];

  const scoreOpts = { isoDate, dateVariants, authorIds };
  const ranked = [...candidates].sort((a, b) => {
    const diff =
      scoreSearchHit(b, query, scoreOpts) - scoreSearchHit(a, query, scoreOpts);
    if (diff !== 0) return diff;
    return createdAtMs(b) - createdAtMs(a);
  });

  const page = ranked.slice(skip, skip + limit);
  const hasMore = ranked.length > skip + limit;
  const enriched = await enrichPostsForViewer(page as never[], params.viewerId);

  return {
    items: enriched as Record<string, unknown>[],
    nextSkip: hasMore ? skip + limit : null,
  };
}
