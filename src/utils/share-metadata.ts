import { Types } from 'mongoose';

import type { Env } from '../config/env.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';

type SharePost = {
  _id: Types.ObjectId;
  location: string;
  caption?: string;
  imageUrl?: string;
  usesDefaultCover?: boolean;
  coverAspectRatio?: number;
  eventDetails?: {
    date?: string | null;
    time?: string | null;
    venue?: string | null;
  } | null;
};

/** CSS aspect-ratio for share hero — mirrors app cover_aspect fallbacks. */
export function resolveShareCoverAspect(post: SharePost): string {
  if (post.usesDefaultCover === true) return String(16 / 9);
  const stored = post.coverAspectRatio;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0.4 && stored <= 3.5) {
    return String(stored);
  }
  return String(16 / 9);
}

export function shareWebBaseUrl(env: Env): string {
  const raw = env.SHARE_WEB_BASE_URL?.trim() || env.PUBLIC_BASE_URL.trim();
  return raw.replace(/\/$/, '');
}

export function buildEventShareUrl(env: Env, postId: string): string {
  return `${shareWebBaseUrl(env)}/e/${postId}`;
}

/** Prefer platform store; falls back to the other, then '#'. */
export function resolveStoreUrl(env: Env, userAgent?: string): string {
  const android = env.ANDROID_STORE_URL?.trim() || '';
  const ios = env.IOS_STORE_URL?.trim() || '';
  const ua = userAgent ?? '';
  if (/iPhone|iPad|iPod/i.test(ua)) return ios || android || '#';
  if (/Android/i.test(ua)) return android || ios || '#';
  return android || ios || '#';
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
    .select('location caption imageUrl usesDefaultCover coverAspectRatio eventDetails authorId')
    .lean();

  if (!post) return null;
  const author = await UserModel.findById(post.authorId)
    .select('settings.isPrivateProfile')
    .lean();
  if (author?.settings?.isPrivateProfile) return null;
  return post as SharePost;
}

export function renderShareLandingPage(
  env: Env,
  post: SharePost,
  opts?: { userAgent?: string },
): string {
  const postId = String(post._id);
  const title = post.location?.trim() || 'Be Ther Event';
  const description = buildShareDescription(post);
  const pageUrl = buildEventShareUrl(env, postId);
  const imageUrl = post.imageUrl?.trim() || '';
  const coverAspect = resolveShareCoverAspect(post);
  const appDeepLink = `bether://e/${postId}`;
  const storeUrl = resolveStoreUrl(env, opts?.userAgent);
  const androidStore = env.ANDROID_STORE_URL?.trim() || '#';
  const iosStore = env.IOS_STORE_URL?.trim() || '#';
  const venue = post.eventDetails?.venue?.trim() || '';
  const date = post.eventDetails?.date?.trim() || '';
  const time = post.eventDetails?.time?.trim() || '';
  const metaLine = [venue, date, time].filter(Boolean).join(' · ');

  const ogImage = imageUrl
    ? `<meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:alt" content="${escapeHtml(title)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
    <link rel="image_src" href="${escapeHtml(imageUrl)}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en" prefix="og: https://ogp.me/ns#">
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
    :root { --cream:#f5f1e8; --navy:#1a2332; --coral:#d4745e; --muted:#c4bdb0; --radius:14px; }
    body { font-family: system-ui, sans-serif; margin: 0; background: var(--navy); color: var(--cream); }
    main { max-width: 480px; margin: 0 auto; padding: 24px 16px 40px; }
    img.hero { width: 100%; aspect-ratio: ${coverAspect}; object-fit: cover; border: 2px solid #0f1419; border-radius: var(--radius); background: var(--cream); }
    h1 { font-size: 1.5rem; margin: 16px 0 8px; color: var(--cream); }
    .meta { color: var(--muted); font-size: 0.9rem; margin: 0 0 12px; }
    p.body { color: var(--muted); line-height: 1.5; margin: 0 0 20px; white-space: pre-line; }
    .actions { display: grid; gap: 10px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    a.btn, button.btn {
      display: block; width: 100%; text-align: center; padding: 14px 12px; font-weight: 700;
      text-decoration: none; border: 2px solid #0f1419; border-radius: var(--radius);
      letter-spacing: 0.04em; font-size: 0.95rem; cursor: pointer; box-sizing: border-box;
      font-family: inherit;
    }
    a.btn-primary, button.btn-primary { background: var(--coral); color: #fff; }
    a.btn-secondary, button.btn-secondary { background: var(--cream); color: var(--navy); }
    a.btn-ghost { background: transparent; color: var(--cream); border-color: rgba(245,241,232,0.35); }
    .hint { margin-top: 16px; font-size: 0.85rem; color: #8a8378; text-align: center; }
    .readonly { margin: 0 0 8px; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8a8378; }
  </style>
</head>
<body>
  <main>
    <p class="readonly">Read-only preview</p>
    ${imageUrl ? `<img class="hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" />` : ''}
    <h1>${escapeHtml(title)}</h1>
    ${metaLine ? `<p class="meta">${escapeHtml(metaLine)}</p>` : ''}
    <p class="body">${escapeHtml(description)}</p>
    <div class="actions">
      <div class="row">
        <button type="button" class="btn btn-secondary" data-store-cta="interested">Interested</button>
        <button type="button" class="btn btn-primary" data-store-cta="going">Going</button>
      </div>
      <a class="btn btn-ghost" id="open-app" href="${escapeHtml(appDeepLink)}">Open in Be Ther</a>
    </div>
    <p class="hint">Have the app? We’ll open this event. Otherwise get Be Ther to join or mark interested.</p>
  </main>
  <script>
    (function () {
      var deepLink = ${JSON.stringify(appDeepLink)};
      var storeUrl = ${JSON.stringify(storeUrl)};
      var androidStore = ${JSON.stringify(androidStore)};
      var iosStore = ${JSON.stringify(iosStore)};
      function pickStore() {
        var ua = navigator.userAgent || '';
        if (/iPhone|iPad|iPod/i.test(ua)) return iosStore !== '#' ? iosStore : storeUrl;
        if (/Android/i.test(ua)) return androidStore !== '#' ? androidStore : storeUrl;
        return storeUrl;
      }
      function goStore() {
        var url = pickStore();
        if (!url || url === '#') {
          alert('App store link coming soon. Install Be Ther to join this event.');
          return;
        }
        window.location.href = url;
      }
      document.querySelectorAll('[data-store-cta]').forEach(function (el) {
        el.addEventListener('click', goStore);
      });
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

/** Branded 404 for dead / private / invalid share links — same chrome as the live preview. */
export function renderShareNotFoundPage(
  env: Env,
  opts?: { userAgent?: string },
): string {
  const homeUrl = shareWebBaseUrl(env) || 'https://be-ther.com';
  const storeUrl = resolveStoreUrl(env, opts?.userAgent);
  const androidStore = env.ANDROID_STORE_URL?.trim() || '#';
  const iosStore = env.IOS_STORE_URL?.trim() || '#';
  const logoUrl = `${homeUrl}/WhatsApp_Image_2026-06-28_at_22.46.20_(1).jpeg`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Event not found · Be Ther</title>
  <meta name="description" content="This Be Ther event link is invalid or no longer available." />
  <meta name="robots" content="noindex" />
  <style>
    :root { --cream:#f5f1e8; --navy:#1a2332; --coral:#d4745e; --muted:#c4bdb0; --radius:14px; --ink:#0f1419; }
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      margin: 0; min-height: 100dvh; background: var(--navy); color: var(--cream);
      display: flex; align-items: center; justify-content: center;
    }
    main {
      width: 100%; max-width: 420px; margin: 0 auto; padding: 32px 20px 40px;
      text-align: center;
    }
    .brand {
      display: inline-flex; align-items: center; gap: 10px;
      text-decoration: none; color: var(--cream); margin-bottom: 28px;
    }
    .brand img {
      width: 44px; height: 44px; border-radius: 12px; object-fit: cover;
      border: 2px solid var(--ink); background: var(--cream);
    }
    .brand span {
      font-weight: 800; letter-spacing: 0.04em; font-size: 1.05rem;
    }
    .art {
      width: 160px; height: 160px; margin: 0 auto 22px;
      border-radius: var(--radius); border: 2px solid var(--ink);
      background: linear-gradient(160deg, #243044 0%, #1a2332 55%, #3d2a28 100%);
      display: grid; place-items: center;
      box-shadow: 6px 6px 0 var(--ink);
    }
    .art svg { width: 96px; height: 96px; }
    .eyebrow {
      margin: 0 0 8px; font-size: 0.72rem; letter-spacing: 0.12em;
      text-transform: uppercase; color: #8a8378; font-weight: 700;
    }
    h1 {
      font-size: 1.65rem; line-height: 1.2; margin: 0 0 10px; color: var(--cream);
      letter-spacing: -0.01em;
    }
    p.body {
      color: var(--muted); line-height: 1.55; margin: 0 0 28px; font-size: 0.98rem;
    }
    .actions { display: grid; gap: 10px; }
    a.btn {
      display: block; width: 100%; text-align: center; padding: 14px 12px; font-weight: 700;
      text-decoration: none; border: 2px solid var(--ink); border-radius: var(--radius);
      letter-spacing: 0.04em; font-size: 0.95rem; cursor: pointer;
      font-family: inherit;
    }
    a.btn-primary { background: var(--coral); color: #fff; }
    a.btn-ghost {
      background: transparent; color: var(--cream);
      border-color: rgba(245,241,232,0.35);
    }
    .hint { margin-top: 18px; font-size: 0.82rem; color: #8a8378; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <a class="brand" href="${escapeHtml(homeUrl)}">
      <img src="${escapeHtml(logoUrl)}" alt="" width="44" height="44" />
      <span>Be Ther</span>
    </a>
    <div class="art" aria-hidden="true">
      <svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="14" y="22" width="68" height="58" rx="10" fill="#f5f1e8" stroke="#0f1419" stroke-width="3"/>
        <rect x="14" y="22" width="68" height="16" rx="10" fill="#d4745e" stroke="#0f1419" stroke-width="3"/>
        <rect x="14" y="30" width="68" height="8" fill="#d4745e"/>
        <path d="M30 16v12M66 16v12" stroke="#0f1419" stroke-width="3" stroke-linecap="round"/>
        <circle cx="34" cy="52" r="4" fill="#1a2332" opacity="0.2"/>
        <circle cx="48" cy="52" r="4" fill="#1a2332" opacity="0.2"/>
        <circle cx="62" cy="52" r="4" fill="#1a2332" opacity="0.2"/>
        <circle cx="34" cy="66" r="4" fill="#1a2332" opacity="0.2"/>
        <circle cx="48" cy="66" r="4" fill="#1a2332" opacity="0.15"/>
        <circle cx="68" cy="70" r="14" fill="#1a2332" stroke="#0f1419" stroke-width="3"/>
        <path d="M62 70h12M68 64v12" stroke="#f5f1e8" stroke-width="3" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="eyebrow">Unavailable</p>
    <h1>This event isn’t here anymore</h1>
    <p class="body">The link may be invalid, private, or the event was removed. Grab Be Ther and find what’s happening next.</p>
    <div class="actions">
      <a class="btn btn-primary" id="get-app" href="${escapeHtml(storeUrl)}">Get Be Ther</a>
      <a class="btn btn-ghost" href="${escapeHtml(homeUrl)}">Back to Be Ther</a>
    </div>
    <p class="hint">On your phone, Get Be Ther opens the App Store or Play Store for your device.</p>
  </main>
  <script>
    (function () {
      var storeUrl = ${JSON.stringify(storeUrl)};
      var androidStore = ${JSON.stringify(androidStore)};
      var iosStore = ${JSON.stringify(iosStore)};
      function pickStore() {
        var ua = navigator.userAgent || '';
        if (/iPhone|iPad|iPod/i.test(ua)) return iosStore !== '#' ? iosStore : storeUrl;
        if (/Android/i.test(ua)) return androidStore !== '#' ? androidStore : storeUrl;
        return storeUrl;
      }
      var btn = document.getElementById('get-app');
      if (!btn) return;
      var url = pickStore();
      if (url && url !== '#') {
        btn.setAttribute('href', url);
      } else {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          alert('App store link coming soon. Visit be-ther.com to learn more.');
        });
      }
    })();
  </script>
</body>
</html>`;
}
