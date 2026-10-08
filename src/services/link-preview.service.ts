import { spawn } from 'node:child_process';

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

/**
 * Jina reader fallback — returns markdown with Title + CDN images even when
 * CF blocks us. Retries once: free tier occasionally 403s under burst load.
 */
async function fetchViaJina(pageUrl: string): Promise<PartialPreview | null> {
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
      if (previewIsUseful(parsed)) return parsed;
    } catch {
      /* retry / give up */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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
 */
export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewResult> {
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
  };

  try {
    let merged: PartialPreview | null = null;

    const html = await loadPageHtml(canonical);
    if (html) {
      merged = {
        imageUrl: extractImageUrl(html, pageUrl),
        title: extractTitle(html),
        description: extractDescription(html),
      };
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
      merged = mergePreview(merged, mergePreview(micro, jina));
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

    if (!merged || !previewIsUseful(merged)) {
      return empty;
    }

    const result = merged;
    return {
      url: canonical,
      imageUrl: pickBestImageUrl(
        [result.imageUrl].filter((u): u is string => Boolean(u)),
      ),
      title: cleanTicketTitle(result.title) ?? result.title,
      description: result.description,
    };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw Object.assign(new Error('Timed out fetching link'), { statusCode: 504 });
    }
    throw Object.assign(new Error('Could not fetch link preview'), { statusCode: 502 });
  }
}
