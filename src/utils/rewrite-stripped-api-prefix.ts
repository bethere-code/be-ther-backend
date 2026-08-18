/**
 * Production nginx `location /api/` + `proxy_pass http://backend/;` strips `/api`.
 * Restore it so `/v1/*` matches routes registered as `/api/v1/*`. Local `/api/v1/*` is unchanged.
 */
export function rewriteStrippedApiPrefix(url: string): string {
  const path = url.split('?')[0] ?? '';
  if (path === '/v1' || path.startsWith('/v1/')) return `/api${url}`;
  return url;
}
