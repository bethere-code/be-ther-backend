import { Types } from 'mongoose';

import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import { enrichPostsForViewer } from '../utils/enrich-posts.js';
import { isPostEventPast, parseEventDateToIso } from '../utils/event-date.js';
import { mapPostToExploreItem } from '../utils/map-post-to-explore.js';

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
const MIN_TOKEN_LEN = 1;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsInsensitive(haystack: unknown, needle: string): boolean {
  if (typeof haystack !== 'string' || !haystack.trim() || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Split query into search tokens; keep full query as a phrase token when multi-word. */
export function tokenizeSearchQuery(raw: string): string[] {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return [];

  const parts = trimmed
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LEN);

  if (parts.length === 0) return [];

  // Prefer individual keywords for AND matching; also try full phrase via score.
  return parts;
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

type ScoreOpts = {
  isoDate: string | null;
  dateVariants: string[];
  authorIdsByToken: Map<string, Set<string>>;
};

/**
 * Best field score for a single token.
 * Ranking: event name > description > place > date > author.
 */
export function scoreTokenHit(
  post: Record<string, unknown>,
  token: string,
  opts: ScoreOpts,
): number {
  const q = token.trim();
  if (!q) return 0;
  const details = post.eventDetails as { venue?: string; date?: string } | undefined;
  const tokenIso = parseSearchDateQuery(q);
  const tokenVariants = tokenIso ? dateSearchVariants(tokenIso) : [];
  const iso = tokenIso ?? opts.isoDate;
  const variants = tokenVariants.length > 0 ? tokenVariants : opts.dateVariants;

  let match = 0;
  if (containsInsensitive(post.location, q)) {
    match = Math.max(match, SCORE.EVENT_NAME);
  }
  if (containsInsensitive(post.caption, q)) {
    match = Math.max(match, SCORE.DESCRIPTION);
  }
  if (containsInsensitive(post.country, q) || containsInsensitive(details?.venue, q)) {
    match = Math.max(match, SCORE.PLACE);
  }
  if (dateFieldMatches(details?.date, q, iso, variants)) {
    match = Math.max(match, SCORE.DATE);
  }
  const authorIds = opts.authorIdsByToken.get(q.toLowerCase());
  if (authorIds?.has(authorIdOf(post))) {
    match = Math.max(match, SCORE.AUTHOR);
  }

  return match;
}

/**
 * Multi-token AND: every token must hit at least one field.
 * Score = sum of per-token best field scores; past events sink.
 */
export function scoreSearchHit(
  post: Record<string, unknown>,
  query: string,
  opts: ScoreOpts,
): number {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    const tokenScore = scoreTokenHit(post, token, opts);
    if (tokenScore <= 0) return 0; // AND — miss any token → no match
    total += tokenScore;
  }

  // Phrase bonus when full query hits event name (search-engine feel).
  const phrase = query.trim();
  if (tokens.length > 1 && containsInsensitive(post.location, phrase)) {
    total += SCORE.EVENT_NAME;
  }

  const past = isPostEventPast(post as Parameters<typeof isPostEventPast>[0]);
  return past ? total - SCORE.PAST_PENALTY : total;
}

function createdAtMs(post: ScoredPost): number {
  if (!post.createdAt) return 0;
  const t = new Date(post.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function fieldMatchersForToken(token: string): Record<string, unknown>[] {
  const escaped = escapeRegex(token);
  const textRegex = { $regex: escaped, $options: 'i' as const };
  const matchers: Record<string, unknown>[] = [
    { location: textRegex },
    { country: textRegex },
    { caption: textRegex },
    { 'eventDetails.venue': textRegex },
    { 'eventDetails.date': textRegex },
  ];

  const isoDate = parseSearchDateQuery(token);
  if (isoDate) {
    for (const variant of dateSearchVariants(isoDate)) {
      matchers.push({
        'eventDetails.date': {
          $regex: escapeRegex(variant),
          $options: 'i',
        },
      });
    }
    matchers.push({ 'eventDetails.date': isoDate });
  }

  return matchers;
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
 * Multi-field event search with tokenized AND matching and priority ranking.
 * Event name > description > place > date; past events always last.
 * Returns explore-shaped items via mapPostToExploreItem.
 */
export async function searchPosts(params: SearchPostsParams): Promise<SearchPostsResult> {
  const query = params.query.trim();
  const skip = Math.max(0, params.skip ?? 0);
  const limit = Math.min(50, Math.max(1, params.limit ?? 10));
  const countryFilter = params.country?.trim();
  const tokens = tokenizeSearchQuery(query);

  if (!query || tokens.length === 0) {
    return { items: [], nextSkip: null };
  }

  const visibility = {
    $or: [{ isPrivate: false }, { authorId: new Types.ObjectId(params.viewerId) }],
  };

  // Each token must match at least one field (Mongo AND of ORs).
  const tokenClauses: Record<string, unknown>[] = [];
  const authorIdsByToken = new Map<string, Set<string>>();

  for (const token of tokens) {
    const matchers = fieldMatchersForToken(token);
    const escaped = escapeRegex(token);
    const textRegex = { $regex: escaped, $options: 'i' as const };

    const matchingAuthors = await UserModel.find({
      $or: [{ username: textRegex }, { displayName: textRegex }],
    })
      .select('_id')
      .limit(50)
      .lean();

    const authorIds = new Set(matchingAuthors.map((u) => String(u._id)));
    authorIdsByToken.set(token.toLowerCase(), authorIds);

    if (matchingAuthors.length > 0) {
      matchers.push({
        authorId: { $in: matchingAuthors.map((u) => u._id) },
      });
    }

    tokenClauses.push({ $or: matchers });
  }

  const filter: Record<string, unknown> = {
    $and: [visibility, ...tokenClauses],
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
    .populate('authorId', 'username displayName avatarUrl')
    .lean()) as ScoredPost[];

  const isoDate = parseSearchDateQuery(query);
  const dateVariants = isoDate ? dateSearchVariants(isoDate) : [];
  const scoreOpts: ScoreOpts = { isoDate, dateVariants, authorIdsByToken };

  // scoreSearchHit returns 0 on AND miss; past matches are negative but valid.
  const ranked = candidates
    .map((post) => ({ post, score: scoreSearchHit(post, query, scoreOpts) }))
    .filter((x) => x.score !== 0)
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return createdAtMs(b.post) - createdAtMs(a.post);
    })
    .map((x) => x.post);

  const page = ranked.slice(skip, skip + limit);
  const hasMore = ranked.length > skip + limit;
  const enriched = await enrichPostsForViewer(page as never[], params.viewerId);
  const items = enriched.map((post) => mapPostToExploreItem(post));

  return {
    items,
    nextSkip: hasMore ? skip + limit : null,
  };
}
