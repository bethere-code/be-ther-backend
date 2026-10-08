import { spawn } from 'node:child_process';

import type { Env } from '../config/env.js';
import {
  autocompletePlaces,
  getPlaceDetails,
  type StructuredPlace,
} from './places.service.js';

const HTML_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 768_000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Crawler UA many ticket sites already allow for WhatsApp / Facebook previews. */
const SOCIAL_UA =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const WHATSAPP_UA = 'WhatsApp/2.23.20.0 A';

/** Free Microlink endpoint — used when Cloudflare blocks our direct fetch. */
const MICROLINK_ENDPOINT = 'https://api.microlink.io/';

/** Jina reader — second fallback when Microlink is rate-limited or thin. */
const JINA_READER_PREFIX = 'https://r.jina.ai/';

export type LinkPreviewResult = {
  url: string;
  imageUrl: string | null;
  title: string | null;
  description: string | null;
  /** Search string used to resolve Google Place (debug / soft UI). */
  venueQuery: string | null;
  /** Resolved venue with lat/lng — null when Places fails or query missing. */
  place: StructuredPlace | null;
  /** Upcoming event day `YYYY-MM-DD`, or null if unknown / already past. */
  date: string | null;
  /** `HH:mm` 24h when found and not already past; else null. */
  time: string | null;
};

function normalizeInputUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme =
    trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/** Block obvious SSRF targets (localhost / private / link-local). */
function isSafePublicUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const c = Number(ipv4[3]);
    const d = Number(ipv4[4]);
    if ([a, b, c, d].some((n) => Number.isNaN(n) || n > 255)) return false;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }

  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return false;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return false;
  }

  return true;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isCloudflareChallenge(html: string, status: number): boolean {
  if (status === 403 || status === 503) return true;
  const lower = html.slice(0, 4000).toLowerCase();
  return (
    lower.includes('attention required! | cloudflare') ||
    lower.includes('cf-browser-verification') ||
    lower.includes('challenge-platform') ||
    lower.includes('just a moment')
  );
}

/**
 * Collects non-empty meta content values.
 * BookMyShow emits empty og:image placeholders first — WhatsApp skips those.
 */
function collectMetaContents(
  html: string,
  attr: 'property' | 'name',
  key: string,
): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      'gi',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${escaped}["'][^>]*>`,
      'gi',
    ),
  ];
  const values: string[] = [];
  for (const re of patterns) {
    for (const match of html.matchAll(re)) {
      const raw = decodeHtmlEntities((match[1] ?? '').trim());
      if (raw) values.push(raw);
    }
  }
  return values;
}

function imageFromPageMetaJson(html: string): string | null {
  const re =
    /"keyValue"\s*:\s*"og:image"\s*,\s*"valueKey"\s*:\s*"content"\s*,\s*"value"\s*:\s*"([^"]+)"/;
  const match = re.exec(html);
  const value = decodeHtmlEntities((match?.[1] ?? '').trim());
  return value || null;
}

/**
 * BookMyShow often lists a tiny share icon (share_v2.png) as og:image before
 * the real event banner. WhatsApp may pick a better asset; we score explicitly.
 */
export function isJunkPreviewImage(url: string): boolean {
  const u = url.toLowerCase();
  if (u.endsWith('.svg')) return true;
  if (u.includes('share_v2')) return true;
  if (u.includes('like_icon') || u.includes('interested_')) return true;
  if (u.includes('/synopsis/') && /icon|chevron|calendar|mticket|time\.png|duration|language|genre|location\.png|navigate/i.test(u)) {
    return true;
  }
  return false;
}

export function pickBestImageUrl(candidates: string[]): string | null {
  const usable = candidates.filter((c) => c && !isJunkPreviewImage(c));
  if (usable.length === 0) return null;
  const banners = usable.filter(
    (c) =>
      /\/events\/banner\//i.test(c) ||
      /\/nmcms\/events\//i.test(c) ||
      /\/Events\/Mobile\//i.test(c) ||
      /media-(desktop|mobile)-/i.test(c),
  );
  return banners[0] ?? usable[0] ?? null;
}

function extractImageUrl(html: string, pageUrl: URL): string | null {
  const raw = [
    ...collectMetaContents(html, 'property', 'og:image'),
    ...collectMetaContents(html, 'property', 'og:image:secure_url'),
    ...collectMetaContents(html, 'name', 'twitter:image'),
    ...collectMetaContents(html, 'name', 'twitter:image:src'),
    ...collectMetaContents(html, 'property', 'twitter:image'),
  ];
  const fromJson = imageFromPageMetaJson(html);
  if (fromJson) raw.push(fromJson);

  const absolute: string[] = [];
  for (const candidate of raw) {
    try {
      const resolved = new URL(candidate, pageUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        continue;
      }
      if (!isSafePublicUrl(resolved)) continue;
      absolute.push(resolved.toString());
    } catch {
      /* ignore */
    }
  }
  return pickBestImageUrl(absolute);
}

/** Collapse whitespace and cap length for form fields. */
export function cleanMetaText(value: string, maxLen: number): string | null {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > Math.floor(maxLen * 0.5) ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/** Strip ticket-site SEO suffixes ("… music-shows Event Tickets … - BookMyShow"). */
export function cleanTicketTitle(value: string | null | undefined): string | null {
  if (!value) return null;
  return (
    cleanMetaText(
      value
        .replace(/\s*[-–|]\s*BookMyShow\s*$/i, '')
        .replace(/\s*,\s*Club Gigs\b.*$/i, '')
        .replace(/\s+Music Shows\b.*$/i, '')
        .replace(/\s+music-shows\b.*$/i, '')
        .replace(/\s+Events?\s+Tickets?\b.*$/i, '')
        .replace(/\s+Event Tickets\b.*$/i, ''),
      200,
    ) ?? null
  );
}

export function extractTitle(html: string): string | null {
  const titles = [
    ...collectMetaContents(html, 'property', 'og:title'),
    ...collectMetaContents(html, 'name', 'twitter:title'),
  ];
  // Fallback: bare <title> when ticket sites omit OG (rare).
  if (titles.length === 0) {
    const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    if (m?.[1]) titles.push(decodeHtmlEntities(m[1]));
  }
  // Event name field max is 200 on the client.
  for (const raw of titles) {
    const cleaned = cleanTicketTitle(raw) ?? cleanMetaText(raw, 200);
    if (cleaned) return cleaned;
  }
  return null;
}

export function extractDescription(html: string): string | null {
  const descriptions = [
    ...collectMetaContents(html, 'property', 'og:description'),
    ...collectMetaContents(html, 'name', 'twitter:description'),
    ...collectMetaContents(html, 'name', 'description'),
  ];
  // Caption / description field max is 500 on the client.
  for (const raw of descriptions) {
    const cleaned = cleanMetaText(raw, 500);
    if (cleaned) return cleaned;
  }
  return null;
}

async function fetchHtmlViaNode(
  pageUrl: string,
  userAgent: string,
): Promise<{ status: number; html: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTML_TIMEOUT_MS);
  try {
    const res = await fetch(pageUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'User-Agent': userAgent,
      },
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.startsWith('image/')) {
      return { status: res.status, html: '' };
    }

    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, html: '' };

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_HTML_BYTES) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }

    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { status: res.status, html };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * System curl often passes Cloudflare TLS fingerprinting where Node's undici
 * fetch gets a 403 challenge page. WhatsApp succeeds for the same reason:
 * their crawler is not a phone/app HTTP stack.
 */
function fetchHtmlViaCurl(pageUrl: string, userAgent: string): Promise<string | null> {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = [
    '-sL',
    '--max-time',
    '12',
    '--max-filesize',
    String(MAX_HTML_BYTES),
    '-A',
    userAgent,
    '-H',
    'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    '-H',
    'Accept-Language: en-IN,en;q=0.9',
    pageUrl,
  ];

  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, HTML_TIMEOUT_MS + 1000);

    child.stdout.on('data', (chunk: Buffer) => {
      if (total >= MAX_HTML_BYTES) return;
      chunks.push(chunk);
      total += chunk.length;
    });
    child.stderr.on('data', () => {
      /* ignore progress / errors — exit code decides */
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const html = Buffer.concat(chunks).toString('utf8');
      if (!html || isCloudflareChallenge(html, 200)) {
        finish(null);
        return;
      }
      finish(html);
    });
  });
}

async function loadPageHtml(pageUrl: string): Promise<string | null> {
  // 1) Prefer social crawler UA via Node (works on some hosts).
  for (const ua of [WHATSAPP_UA, SOCIAL_UA, BROWSER_UA]) {
    const viaNode = await fetchHtmlViaNode(pageUrl, ua);
    if (
      viaNode &&
      viaNode.html &&
      !isCloudflareChallenge(viaNode.html, viaNode.status) &&
      viaNode.status >= 200 &&
      viaNode.status < 400
    ) {
      return viaNode.html;
    }
  }

  // 2) Curl fallback — different TLS fingerprint; sometimes bypasses light CF.
  for (const ua of [WHATSAPP_UA, SOCIAL_UA, BROWSER_UA]) {
    const viaCurl = await fetchHtmlViaCurl(pageUrl, ua);
    if (viaCurl) return viaCurl;
  }

  return null;
}

type PartialPreview = {
  imageUrl: string | null;
  title: string | null;
  description: string | null;
};

function previewIsUseful(p: PartialPreview | null): boolean {
  if (!p) return false;
  return Boolean(p.title || p.description || p.imageUrl);
}

function mergePreview(
  base: PartialPreview | null,
  extra: PartialPreview | null,
): PartialPreview {
  const images = [base?.imageUrl, extra?.imageUrl].filter(
    (u): u is string => Boolean(u),
  );
  return {
    title: base?.title ?? extra?.title ?? null,
    description: base?.description ?? extra?.description ?? null,
    imageUrl: pickBestImageUrl(images),
  };
}

function microlinkImageUrl(
  image: { url?: string } | string | null | undefined,
): string | null {
  if (typeof image === 'string') return image || null;
  if (image && typeof image === 'object') return image.url ?? null;
  return null;
}

/**
 * Microlink free API — Meta/WhatsApp-class crawlers are allowlisted by CF;
 * our VPS/dev IP is not. Microlink fetches from their edge instead.
 *
 * When `wantScreenshot` is true, also request a page screenshot — used only
 * as a last-resort cover when OG image is a junk share icon (BookMyShow).
 */
async function fetchViaMicrolink(
  pageUrl: string,
  wantScreenshot = false,
): Promise<PartialPreview | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTML_TIMEOUT_MS + (wantScreenshot ? 8_000 : 0));
  try {
    const api = new URL(MICROLINK_ENDPOINT);
    api.searchParams.set('url', pageUrl);
    if (wantScreenshot) api.searchParams.set('screenshot', 'true');
    const res = await fetch(api.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: string;
      data?: {
        title?: string;
        description?: string;
        image?: { url?: string } | string | null;
        screenshot?: { url?: string } | string | null;
      };
    };
    if (json.status !== 'success' || !json.data) return null;

    const ogImage = microlinkImageUrl(json.data.image);
    const shot = microlinkImageUrl(json.data.screenshot);
    // Prefer real OG assets; screenshot only when OG is missing/junk.
    const imageUrl = pickBestImageUrl(
      [ogImage, wantScreenshot ? shot : null].filter((u): u is string => Boolean(u)),
    );

    return {
      title: cleanTicketTitle(json.data.title ?? ''),
      description: cleanMetaText(json.data.description ?? '', 500),
      imageUrl,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJinaMarkdown(text: string): PartialPreview {
  const titleLine = /^Title:\s*(.+)$/m.exec(text)?.[1] ?? null;
  const title = cleanTicketTitle(titleLine);

  const imageMatches = [
    ...text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g),
  ]
    .map((m) => m[1])
    .filter((u): u is string => Boolean(u));
  const imageUrl = pickBestImageUrl(imageMatches);

  let description: string | null = null;
  const para = text.match(
    /(?:^|\n)((?:Experience|Join|Book|Enjoy|Witness)[^\n]{80,480})/i,
  );
  if (para?.[1]) description = cleanMetaText(para[1], 500);

  return { title, description, imageUrl };
}

type JinaFetchResult = { preview: PartialPreview; text: string };

/**
 * Jina reader fallback — returns markdown with Title + CDN images even when
 * CF blocks us. Retries once: free tier occasionally 403s under burst load.
 */
async function fetchViaJina(pageUrl: string): Promise<JinaFetchResult | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 600));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTML_TIMEOUT_MS + 5_000);
    try {
      const res = await fetch(`${JINA_READER_PREFIX}${pageUrl}`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'text/plain',
          'X-Return-Format': 'markdown',
          'User-Agent': BROWSER_UA,
        },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || isCloudflareChallenge(text, res.status)) continue;
      const parsed = parseJinaMarkdown(text);
      if (previewIsUseful(parsed)) return { preview: parsed, text };
    } catch {
      /* retry / give up */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Calendar day in Asia/Kolkata as `YYYY-MM-DD` (ticket sites are India-centric). */
export function todayYmdIst(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function ymdFromParts(year: number, monthIndex: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(day) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  if (day < 1 || day > 31 || year < 2020 || year > 2100) return null;
  const dt = new Date(Date.UTC(year, monthIndex, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== monthIndex ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

/** Parse `HH:mm` from 12h/24h snippets near a date mention. */
export function parseEventTime(raw: string): string | null {
  const withMinutes = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(raw);
  if (withMinutes) {
    let hour = Number(withMinutes[1]);
    const minute = Number(withMinutes[2]);
    const ampm = (withMinutes[3] ?? '').toLowerCase();
    if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59) return null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!ampm && hour > 23) return null;
    if (ampm && (hour < 0 || hour > 23)) return null;
    return `${pad2(hour)}:${pad2(minute)}`;
  }
  const hourOnly = /\b(\d{1,2})\s*(am|pm)\b/i.exec(raw);
  if (!hourOnly?.[1] || !hourOnly[2]) return null;
  let hour = Number(hourOnly[1]);
  const ampm = hourOnly[2].toLowerCase();
  if (Number.isNaN(hour) || hour < 1 || hour > 12) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return `${pad2(hour)}:00`;
}

/**
 * Prefer page calendar dates ("Sun 11 Oct 2026") over stale URL slugs ("july-19").
 * Returns null when the day is already past (IST).
 */
export function extractEventDateTime(
  corpus: string,
): { date: string; time: string | null } | null {
  const text = scrubPlainText(corpus);
  const monthAlt = Object.keys(MONTH_INDEX).join('|');
  const withDow = new RegExp(
    String.raw`(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2})\s+(${monthAlt})\s+(\d{4})\b`,
    'i',
  );
  const plain = new RegExp(
    String.raw`\b(\d{1,2})\s+(${monthAlt})\s+(\d{4})\b`,
    'i',
  );
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/;

  let date: string | null = null;
  let dateIndex = -1;

  for (const re of [withDow, plain]) {
    const m = re.exec(text);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const day = Number(m[1]);
    const monthIndex = MONTH_INDEX[m[2].toLowerCase()];
    const year = Number(m[3]);
    if (monthIndex === undefined) continue;
    date = ymdFromParts(year, monthIndex, day);
    dateIndex = m.index;
    if (date) break;
  }

  if (!date) {
    const m = iso.exec(text);
    if (m?.[1] && m[2] && m[3]) {
      date = `${m[1]}-${m[2]}-${m[3]}`;
      dateIndex = m.index;
      if (m[4] && m[5]) {
        const time = `${m[4]}:${m[5]}`;
        return filterUpcomingDateTime(date, time);
      }
    }
  }

  if (!date) return null;

  let time: string | null = null;
  if (dateIndex >= 0) {
    const window = text.slice(
      Math.max(0, dateIndex - 80),
      Math.min(text.length, dateIndex + 160),
    );
    time = parseEventTime(window);
  }

  return filterUpcomingDateTime(date, time);
}

/** Drop past calendar days; if today + past clock time, keep date and drop time. */
export function filterUpcomingDateTime(
  date: string,
  time: string | null,
  now = new Date(),
): { date: string; time: string | null } | null {
  const today = todayYmdIst(now);
  if (date < today) return null;
  if (!time || date > today) return { date, time };

  // Same day — require time still in the future (IST clock).
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const nowHm = `${hh}:${mm}`;
  if (time <= nowHm) return { date, time: null };
  return { date, time };
}

function scrubPlainText(corpus: string): string {
  return corpus
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/["']+/g, ' ')
    // Keep newlines so venue/title lines don't glue together.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

function tidyVenueQuery(raw: string): string | null {
  const q = cleanMetaText(
    raw
      .replace(/\s+on\s+BookMyShow\b.*$/i, '')
      .replace(/\s+which is\b.*$/i, '')
      .replace(/\s+music-shows\b.*$/i, '')
      .replace(/:/g, ' ')
      .replace(/[^A-Za-z0-9 &.',-]/g, ' '),
    80,
  );
  if (!q || q.length < 3) return null;
  // Reject HTML/meta leftovers that slipped through.
  if (/content=|keywords|og:|http|www\./i.test(q)) return null;
  return q.replace(/\s+/g, ' ').trim();
}

/** Venue search string from ticket copy / URL (e.g. "Akan Hyderabad"). */
export function extractVenueQuery(corpus: string, pageUrl: URL): string | null {
  const text = scrubPlainText(corpus);
  // Keep venue/city tokens on one line — `\s` must not span newlines into titles.
  const patterns: RegExp[] = [
    // "happening at Akan: Hyderabad"
    /happening at[ \t]+([A-Za-z0-9 &.'-]{2,40}?)[ \t]*:[ \t]*([A-Za-z][A-Za-z -]{1,40})\b/i,
    /happening at[ \t]+([A-Za-z][A-Za-z0-9 &.'-]{2,50}?)(?=[ \t]+on\b|[ \t]+which\b|\.|$)/i,
    /takes the stage at[ \t]+([A-Za-z][A-Za-z0-9 &.'-]{2,50}?)(?=[ \t]+on\b|[ \t]+which\b|\.|$)/i,
    /(?:venue|location)[ \t]*[:|-][ \t]*([A-Za-z][A-Za-z0-9 &.',-]{2,60})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const raw = m[2] ? `${m[1]} ${m[2]}` : m[1];
    const q = tidyVenueQuery(raw);
    if (q && q.split(' ').length <= 6) return q;
  }

  // BookMyShow book-now path often embeds a venue code: /ticket/AKAN/10750
  const ticketVenue = /\/ticket\/([A-Z][A-Z0-9]{2,12})\//i.exec(corpus);
  if (ticketVenue?.[1]) {
    const city =
      /\bin[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)\b/.exec(text)?.[1] ?? null;
    const code = ticketVenue[1].replace(/[-_]/g, ' ');
    const q = tidyVenueQuery(city ? `${code} ${city}` : code);
    if (q && q.split(' ').length >= 2) return q;
  }

  // Slug alone ("akan") is too weak for Places — require a city from copy.
  const slug = /\/events\/([^/]+)\//i.exec(pageUrl.pathname)?.[1];
  if (slug) {
    const at = /-at-([a-z0-9-]+?)(?:-january|-february|-march|-april|-may|-june|-july|-august|-september|-october|-november|-december|-\d|$)/i.exec(
      slug,
    );
    const city =
      /\bin[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)\b/.exec(text)?.[1] ?? null;
    if (at?.[1] && city) {
      const q = tidyVenueQuery(`${at[1].replace(/-/g, ' ')} ${city}`);
      if (q) return q;
    }
  }

  return null;
}

async function resolveVenuePlace(
  env: Env | undefined,
  query: string,
  pageUrl: URL,
): Promise<StructuredPlace | null> {
  if (!env?.GOOGLE_PLACES_API_KEY?.trim()) return null;
  let q = query.trim();
  if (q.length < 3) return null;
  // BookMyShow / Indian ticket hosts — bias autocomplete to India.
  const host = pageUrl.hostname.toLowerCase();
  const indiaHost =
    host.includes('bookmyshow.') ||
    host.endsWith('bms.co.in') ||
    host.includes('district.in');
  if (indiaHost && !/\bindia\b/i.test(q)) {
    q = `${q} India`;
  }
  // Hyderabad ~ center bias when city is named (reduces foreign false matches).
  let lat: number | undefined;
  let lng: number | undefined;
  if (/\bhyderabad\b/i.test(q)) {
    lat = 17.385;
    lng = 78.4867;
  } else if (indiaHost) {
    lat = 20.5937;
    lng = 78.9629;
  }
  try {
    const suggestions = await autocompletePlaces(env, { query: q, lat, lng });
    const first = suggestions[0];
    if (!first?.placeId) return null;
    return await getPlaceDetails(env, { placeId: first.placeId });
  } catch {
    return null;
  }
}

function needsUsableCover(p: PartialPreview | null): boolean {
  return !p?.imageUrl || isJunkPreviewImage(p.imageUrl);
}

/**
 * BookMyShow serves a stable mobile poster at
 * `https://in.bmscdn.com/Events/Mobile/{ET…}.jpg` — no Cloudflare on the CDN.
 * WhatsApp often ends up with this (or the desktop banner); we use it when OG
 * only exposes the junk share_v2 icon.
 */
export function bookMyShowMobileBannerUrl(pageUrl: URL): string | null {
  const host = pageUrl.hostname.toLowerCase();
  if (!host.includes('bookmyshow.') && !host.endsWith('bms.co.in')) return null;
  const match = /\/(ET\d{5,})\b/i.exec(pageUrl.pathname);
  if (!match?.[1]) return null;
  return `https://in.bmscdn.com/Events/Mobile/${match[1].toUpperCase()}.jpg`;
}

/** Confirm CDN asset exists before using it as cover. */
async function urlLooksLikeImage(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type.startsWith('image/')) return true;
    // Some CDNs omit content-type on HEAD — accept non-tiny bodies.
    const len = Number(res.headers.get('content-length') ?? '0');
    return Number.isFinite(len) && len > 2_000;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server-side link preview (WhatsApp architecture).
 *
 * Direct fetch often fails on Cloudflare-protected ticket sites (BookMyShow):
 * WhatsApp works because Meta's crawler IPs are allowlisted — ours are not.
 * Fallback chain: direct HTML → Microlink meta → Jina reader → Microlink screenshot.
 * Then extract venue/date/time and resolve place via Google Places when configured.
 */
export async function fetchLinkPreview(
  rawUrl: string,
  env?: Env,
): Promise<LinkPreviewResult> {
  const pageUrl = normalizeInputUrl(rawUrl);
  if (!pageUrl || !isSafePublicUrl(pageUrl)) {
    throw Object.assign(new Error('Invalid or unsupported URL'), { statusCode: 400 });
  }

  const canonical = pageUrl.toString();
  const empty: LinkPreviewResult = {
    url: canonical,
    imageUrl: null,
    title: null,
    description: null,
    venueQuery: null,
    place: null,
    date: null,
    time: null,
  };

  try {
    let merged: PartialPreview | null = null;
    let metaCorpus = '';
    let hadJinaText = false;

    const html = await loadPageHtml(canonical);
    if (html) {
      merged = {
        imageUrl: extractImageUrl(html, pageUrl),
        title: extractTitle(html),
        description: extractDescription(html),
      };
      metaCorpus += `\n${html.slice(0, 120_000)}`;
    }

    // CF blocked us, or page only gave a junk share icon / no title.
    // Run Microlink + Jina in parallel — Jina usually has the real banner;
    // Microlink is stronger on title/description when Jina rate-limits.
    const needsFallback =
      !merged ||
      !merged.title ||
      needsUsableCover(merged);

    if (needsFallback) {
      const [micro, jina] = await Promise.all([
        fetchViaMicrolink(canonical, false),
        fetchViaJina(canonical),
      ]);
      merged = mergePreview(merged, mergePreview(micro, jina?.preview ?? null));
      if (jina?.text) {
        metaCorpus += `\n${jina.text}`;
        hadJinaText = true;
      }
    }

    // BMS: CDN mobile poster from event code (ET…) — reliable when CF blocks HTML
    // and Microlink/Jina only see share_v2.png.
    if (needsUsableCover(merged)) {
      const bmsBanner = bookMyShowMobileBannerUrl(pageUrl);
      if (bmsBanner && (await urlLooksLikeImage(bmsBanner))) {
        merged = mergePreview(merged, {
          title: null,
          description: null,
          imageUrl: bmsBanner,
        });
      }
    }

    // Last resort: full-page screenshot so the post still gets a cover
    // when OG is only share_v2.png and Jina was rate-limited.
    if (needsUsableCover(merged)) {
      const shot = await fetchViaMicrolink(canonical, true);
      if (shot) merged = mergePreview(merged, shot);
    }

    // OG may succeed without Jina — still need page text for venue/date.
    if (!hadJinaText) {
      const probe = `${metaCorpus}\n${merged?.title ?? ''}\n${merged?.description ?? ''}`;
      const needMeta =
        !extractVenueQuery(probe, pageUrl) || !extractEventDateTime(probe);
      if (needMeta) {
        const jinaOnly = await fetchViaJina(canonical);
        if (jinaOnly?.text) {
          metaCorpus += `\n${jinaOnly.text}`;
          if (!previewIsUseful(merged)) {
            merged = mergePreview(merged, jinaOnly.preview);
          }
        }
      }
    }

    if (!merged || !previewIsUseful(merged)) {
      return empty;
    }

    const result = merged;
    metaCorpus += `\n${result.title ?? ''}\n${result.description ?? ''}\n${canonical}`;

    // Prefer description alone for venue — titles glue into city names after scrub.
    const venueQuery =
      extractVenueQuery(result.description ?? '', pageUrl) ??
      extractVenueQuery(metaCorpus.slice(0, 20_000), pageUrl);
    const when =
      extractEventDateTime(metaCorpus) ??
      extractEventDateTime(`${result.description ?? ''}\n${canonical}`);
    const place = venueQuery
      ? await resolveVenuePlace(env, venueQuery, pageUrl)
      : null;

    return {
      url: canonical,
      imageUrl: pickBestImageUrl(
        [result.imageUrl].filter((u): u is string => Boolean(u)),
      ),
      title: cleanTicketTitle(result.title) ?? result.title,
      description: result.description,
      venueQuery,
      place,
      date: when?.date ?? null,
      time: when?.time ?? null,
    };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw Object.assign(new Error('Timed out fetching link'), { statusCode: 504 });
    }
    throw Object.assign(new Error('Could not fetch link preview'), { statusCode: 502 });
  }
}
