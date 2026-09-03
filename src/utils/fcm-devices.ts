import type { Types } from 'mongoose';

/** Cap devices per user to avoid unbounded token growth. */
export const FCM_DEVICES_MAX = 10;

export type FcmDevice = {
  token: string;
  platform: string;
  updatedAt: Date;
};

/** Normalize a city name into an FCM topic: `city_hyderabad`. */
export function cityTopicSlug(city: string): string | null {
  const raw = city.trim().toLowerCase();
  if (!raw) return null;
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!slug || slug.length < 2) return null;
  // FCM topic: [a-zA-Z0-9-_.~%]{1,900}
  return `city_${slug}`;
}

export const BROADCAST_TOPIC = 'broadcast';

export function upsertFcmDevice(
  devices: FcmDevice[] | undefined | null,
  token: string,
  platform: string,
): FcmDevice[] {
  const t = token.trim().slice(0, 4096);
  if (!t) return Array.isArray(devices) ? [...devices] : [];
  const plat = platform.trim().slice(0, 32) || 'unknown';
  const now = new Date();
  const next = (Array.isArray(devices) ? devices : [])
    .filter((d) => d && typeof d.token === 'string' && d.token.trim() !== t)
    .map((d) => ({
      token: String(d.token).slice(0, 4096),
      platform: String(d.platform ?? '').slice(0, 32),
      updatedAt: d.updatedAt instanceof Date ? d.updatedAt : new Date(d.updatedAt ?? now),
    }));
  next.unshift({ token: t, platform: plat, updatedAt: now });
  return next.slice(0, FCM_DEVICES_MAX);
}

export function removeFcmDevice(
  devices: FcmDevice[] | undefined | null,
  token: string,
): FcmDevice[] {
  const t = token.trim();
  if (!t) return Array.isArray(devices) ? [...devices] : [];
  return (Array.isArray(devices) ? devices : []).filter(
    (d) => d && String(d.token).trim() !== t,
  );
}

export function collectUserTokens(user: {
  fcmToken?: string | null;
  fcmDevices?: Array<{ token?: string | null }> | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of user.fcmDevices ?? []) {
    const t = String(d?.token ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  const legacy = String(user.fcmToken ?? '').trim();
  if (legacy && !seen.has(legacy)) out.push(legacy);
  return out;
}

export type NotifyActor = {
  _id?: Types.ObjectId | string;
  username?: string;
  displayName?: string;
};
