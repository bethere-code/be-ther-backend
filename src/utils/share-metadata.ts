import { Types } from 'mongoose';

import type { Env } from '../config/env.js';
import { PostModel } from '../models/post.model.js';

type SharePost = {
  _id: Types.ObjectId;
  location: string;
  caption?: string;
  imageUrl?: string;
  eventDetails?: {
    date?: string | null;
    time?: string | null;
    venue?: string | null;
  } | null;
};

export function shareWebBaseUrl(env: Env): string {
  const raw = env.SHARE_WEB_BASE_URL?.trim() || env.PUBLIC_BASE_URL.trim();
  return raw.replace(/\/$/, '');
}

export function buildEventShareUrl(env: Env, postId: string): string {
  return `${shareWebBaseUrl(env)}/e/${postId}`;
}

export function buildShareDescription(post: SharePost): string {
  const caption = post.caption?.trim();
  if (caption) {
    return caption.length > 200 ? `${caption.slice(0, 197)}...` : caption;
  }

  const venue = post.eventDetails?.venue?.trim();
  const date = post.eventDetails?.date?.trim();
  const parts = [venue, date].filter((part) => part && part.length > 0);
  if (parts.length > 0) {
    return parts.join(' · ');
  }

  return `Discover ${post.location} on Be Ther`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function loadPublicPostForShare(postId: string): Promise<SharePost | null> {
  if (!Types.ObjectId.isValid(postId)) return null;

  const post = await PostModel.findOne({ _id: postId, isPrivate: false })
    .select('location caption imageUrl eventDetails')
    .lean();

  if (!post) return null;
  return post as SharePost;
}

export function renderShareLandingPage(env: Env, post: SharePost): string {
  const postId = String(post._id);
  const title = post.location?.trim() || 'Be Ther Event';
  const description = buildShareDescription(post);
  const pageUrl = buildEventShareUrl(env, postId);
  const imageUrl = post.imageUrl?.trim() || '';
  const appDeepLink = `bether://e/${postId}`;

  const ogImage = imageUrl
    ? `<meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Be Ther</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Be Ther" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  ${ogImage}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f0f0f; color: #f5f5f5; }
    main { max-width: 480px; margin: 0 auto; padding: 24px 16px 40px; }
    img.hero { width: 100%; aspect-ratio: 16/10; object-fit: cover; border: 2px solid #222; }
    h1 { font-size: 1.5rem; margin: 16px 0 8px; }
    p { color: #bdbdbd; line-height: 1.5; margin: 0 0 20px; white-space: pre-line; }
    a.btn { display: block; text-align: center; background: #c8ff00; color: #111; padding: 14px; font-weight: 700; text-decoration: none; border: 2px solid #111; }
    .hint { margin-top: 16px; font-size: 0.85rem; color: #888; text-align: center; }
  </style>
</head>
<body>
  <main>
    ${imageUrl ? `<img class="hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" />` : ''}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
    <a class="btn" id="open-app" href="${escapeHtml(appDeepLink)}">Open in Be Ther</a>
    <p class="hint">If the app is not installed, stay on this page to view the event.</p>
  </main>
  <script>
    (function () {
      var deepLink = ${JSON.stringify(appDeepLink)};
      var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (!isMobile) return;
      var openedAt = Date.now();
      window.location.href = deepLink;
      setTimeout(function () {
        if (Date.now() - openedAt < 2200) {
          document.getElementById('open-app')?.focus();
        }
      }, 1800);
    })();
  </script>
</body>
</html>`;
}

export function renderShareNotFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Event not found · Be Ther</title>
</head>
<body style="font-family:system-ui,sans-serif;background:#0f0f0f;color:#f5f5f5;text-align:center;padding:48px 16px;">
  <h1>Event not found</h1>
  <p>This link may be invalid or the event is no longer available.</p>
</body>
</html>`;
}
