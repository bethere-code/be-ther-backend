import { spawn } from 'node:child_process';

const HTML_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 768_000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Crawler UA many ticket sites already allow for WhatsApp / Facebook previews. */
const SOCIAL_UA =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export type LinkPreviewResult = {
  url: string;
  imageUrl: string | null;
  title: string | null;
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

function extractImageUrl(html: string, pageUrl: URL): string | null {
  const candidates = [
    ...collectMetaContents(html, 'property', 'og:image'),
    ...collectMetaContents(html, 'property', 'og:image:secure_url'),
    ...collectMetaContents(html, 'name', 'twitter:image'),
    ...collectMetaContents(html, 'name', 'twitter:image:src'),
    ...collectMetaContents(html, 'property', 'twitter:image'),
  ];
  const fromJson = imageFromPageMetaJson(html);
  if (fromJson) candidates.push(fromJson);

  for (const candidate of candidates) {
    try {
      const absolute = new URL(candidate, pageUrl);
      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
        continue;
      }
      if (!isSafePublicUrl(absolute)) continue;
      return absolute.toString();
    } catch {
      /* ignore */
    }
  }
  return null;
}

function extractTitle(html: string): string | null {
  const titles = [
    ...collectMetaContents(html, 'property', 'og:title'),
    ...collectMetaContents(html, 'name', 'twitter:title'),
  ];
  return titles[0] ?? null;
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
  for (const ua of [SOCIAL_UA, BROWSER_UA]) {
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

  // 2) Curl fallback — different TLS fingerprint; works for BookMyShow/CF.
  for (const ua of [SOCIAL_UA, BROWSER_UA]) {
    const viaCurl = await fetchHtmlViaCurl(pageUrl, ua);
    if (viaCurl) return viaCurl;
  }

  return null;
}

/**
 * Server-side link preview (WhatsApp architecture).
 * Phone scrapes fail on Cloudflare-protected ticket sites; Meta's servers
 * (and our API + curl) fetch the HTML instead.
 */
export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewResult> {
  const pageUrl = normalizeInputUrl(rawUrl);
  if (!pageUrl || !isSafePublicUrl(pageUrl)) {
    throw Object.assign(new Error('Invalid or unsupported URL'), { statusCode: 400 });
  }

  try {
    const html = await loadPageHtml(pageUrl.toString());
    if (!html) {
      return { url: pageUrl.toString(), imageUrl: null, title: null };
    }

    return {
      url: pageUrl.toString(),
      imageUrl: extractImageUrl(html, pageUrl),
      title: extractTitle(html),
    };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw Object.assign(new Error('Timed out fetching link'), { statusCode: 504 });
    }
    throw Object.assign(new Error('Could not fetch link preview'), { statusCode: 502 });
  }
}
