const HTML_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 512_000;

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

  // IPv4
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const c = Number(ipv4[3]);
    const d = Number(ipv4[4]);
    if ([a, b, c, d].some((n) => Number.isNaN(n) || n > 255)) return false;
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  }

  // IPv6 loopback / ULA / link-local
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return false;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return false;
  }

  return true;
}

function pickMetaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${escaped}["'][^>]*>`,
      'i',
    ),
  ];
  for (const re of patterns) {
    const match = re.exec(html);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }
  return null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function resolveImageUrl(candidate: string, pageUrl: URL): string | null {
  try {
    const absolute = new URL(candidate, pageUrl);
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
    if (!isSafePublicUrl(absolute)) return null;
    return absolute.toString();
  } catch {
    return null;
  }
}

function extractImageUrl(html: string, pageUrl: URL): string | null {
  const keys: Array<{ attr: 'property' | 'name'; key: string }> = [
    { attr: 'property', key: 'og:image' },
    { attr: 'property', key: 'og:image:secure_url' },
    { attr: 'name', key: 'twitter:image' },
    { attr: 'name', key: 'twitter:image:src' },
  ];
  for (const { attr, key } of keys) {
    const raw = pickMetaContent(html, attr, key);
    if (!raw) continue;
    const resolved = resolveImageUrl(raw, pageUrl);
    if (resolved) return resolved;
  }

  const linkMatch =
    /<link[^>]+rel=["'][^"']*image_src[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/i.exec(
      html,
    ) ??
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*image_src[^"']*["'][^>]*>/i.exec(
      html,
    );
  if (linkMatch?.[1]) {
    return resolveImageUrl(decodeHtmlEntities(linkMatch[1].trim()), pageUrl);
  }

  return null;
}

export type LinkPreviewResult = {
  url: string;
  imageUrl: string | null;
  title: string | null;
};

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewResult> {
  const pageUrl = normalizeInputUrl(rawUrl);
  if (!pageUrl || !isSafePublicUrl(pageUrl)) {
    throw Object.assign(new Error('Invalid or unsupported URL'), { statusCode: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTML_TIMEOUT_MS);

  try {
    const res = await fetch(pageUrl.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (compatible; BeTherBot/1.0; +https://be-ther.app)',
      },
    });

    if (!res.ok) {
      return { url: pageUrl.toString(), imageUrl: null, title: null };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (
      contentType &&
      !contentType.includes('text/html') &&
      !contentType.includes('application/xhtml') &&
      !contentType.includes('text/plain')
    ) {
      // Direct image link pasted as ticket URL — use it as the preview.
      if (contentType.startsWith('image/')) {
        return { url: pageUrl.toString(), imageUrl: pageUrl.toString(), title: null };
      }
      return { url: pageUrl.toString(), imageUrl: null, title: null };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return { url: pageUrl.toString(), imageUrl: null, title: null };
    }

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
    const imageUrl = extractImageUrl(html, pageUrl);
    const title =
      pickMetaContent(html, 'property', 'og:title') ??
      pickMetaContent(html, 'name', 'twitter:title') ??
      null;

    return { url: pageUrl.toString(), imageUrl, title };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw Object.assign(new Error('Timed out fetching link'), { statusCode: 504 });
    }
    throw Object.assign(new Error('Could not fetch link preview'), { statusCode: 502 });
  } finally {
    clearTimeout(timer);
  }
}
