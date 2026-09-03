import { readFileSync } from 'node:fs';

import admin from 'firebase-admin';

import type { Env } from '../config/env.js';
import { UserModel } from '../models/user.model.js';
import {
  BROADCAST_TOPIC,
  cityTopicSlug,
  collectUserTokens,
  removeFcmDevice,
} from '../utils/fcm-devices.js';
export type PushData = Record<string, string>;

const log = {
  info: (msg: string, extra?: unknown) =>
    console.info(`[fcm] ${msg}`, extra ?? ''),
  warn: (msg: string, extra?: unknown) =>
    console.warn(`[fcm] ${msg}`, extra ?? ''),
  error: (msg: string, extra?: unknown) =>
    console.error(`[fcm] ${msg}`, extra ?? ''),
};

export type PushPayload = {
  title: string;
  body: string;
  data?: PushData;
  /** Data-only: OS will not show a banner; app refreshes silently. */
  silent?: boolean;
};

let messaging: admin.messaging.Messaging | null = null;
let initAttempted = false;

function loadServiceAccount(env: Env): admin.ServiceAccount | null {
  const rawJson = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    try {
      return JSON.parse(rawJson) as admin.ServiceAccount;
    } catch (err) {
      log.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON', err);
      return null;
    }
  }
  const path = env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (path) {
    try {
      const text = readFileSync(path, 'utf8');
      return JSON.parse(text) as admin.ServiceAccount;
    } catch (err) {
      log.error('Failed to read FIREBASE_SERVICE_ACCOUNT_PATH', { err, path });
      return null;
    }
  }
  return null;
}

/** Idempotent init — safe to call from app boot. */
export function initFirebaseAdmin(env: Env): void {
  if (initAttempted) return;
  initAttempted = true;
  const sa = loadServiceAccount(env);
  if (!sa) {
    log.warn(
      'Firebase Admin not configured — push sends skipped (set FIREBASE_SERVICE_ACCOUNT_JSON or PATH)',
    );
    return;
  }
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    }
    messaging = admin.messaging();
    log.info('Firebase Admin messaging ready');
  } catch (err) {
    log.error('Firebase Admin init failed', err);
    messaging = null;
  }
}

function isInvalidTokenError(code: string | undefined): boolean {
  if (!code) return false;
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument'
  );
}

async function pruneTokens(userId: string, badTokens: string[]): Promise<void> {
  if (badTokens.length === 0) return;
  const user = await UserModel.findById(userId);
  if (!user) return;
  let devices = (user.get('fcmDevices') as { token: string; platform: string; updatedAt: Date }[]) ?? [];
  for (const t of badTokens) {
    devices = removeFcmDevice(devices, t);
  }
  user.set('fcmDevices', devices);
  user.markModified('fcmDevices');
  const legacy = String(user.get('fcmToken') ?? '');
  if (badTokens.includes(legacy)) user.set('fcmToken', '');
  await user.save();
}

function buildMessage(
  token: string,
  payload: PushPayload,
): admin.messaging.Message {
  const data: PushData = { ...(payload.data ?? {}) };
  // All data values must be strings for FCM.
  for (const [k, v] of Object.entries(data)) {
    data[k] = String(v ?? '');
  }

  if (payload.silent) {
    return {
      token,
      data: { ...data, type: data.type || 'unread_sync' },
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
        payload: { aps: { 'content-available': 1 } },
      },
    };
  }

  // Single visible notification: use FCM `notification` so OS shows once in
  // background/killed. App shows a local notif ONLY while foreground.
  return {
    token,
    notification: { title: payload.title, body: payload.body },
    data: { ...data, type: data.type || 'social' },
    android: {
      priority: 'high',
      notification: {
        channelId: 'be_ther_alerts',
        // Avoid duplicate when app is in background — system tray only.
        // flutter_local_notifications used only in foreground.
      },
    },
    apns: {
      payload: {
        aps: {
          alert: { title: payload.title, body: payload.body },
          sound: 'default',
        },
      },
    },
  };
}

/** Send to one user's registered devices. Never throws to callers. */
export async function sendToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!messaging) return;
  try {
    const user = await UserModel.findById(userId)
      .select('fcmToken fcmDevices settings.pushEnabled')
      .lean();
    if (!user) return;
    const settings = user.settings as { pushEnabled?: boolean } | undefined;
    if (settings && settings.pushEnabled === false) return;

    const tokens = collectUserTokens(user);
    if (tokens.length === 0) return;

    const bad: string[] = [];
    // sendEach avoids 500-token multicast limit edge cases for small device lists
    const res = await messaging.sendEach(tokens.map((t) => buildMessage(t, payload)));
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code;
      if (isInvalidTokenError(code)) bad.push(tokens[i]!);
      else log.warn('FCM send failed', { code, userId });
    });
    if (bad.length) await pruneTokens(userId, bad);
  } catch (err) {
    log.warn('sendToUser failed', { err, userId });
  }
}

export async function sendToTokens(
  tokens: string[],
  payload: PushPayload,
  onInvalid?: (token: string) => void,
): Promise<{ success: number; failure: number }> {
  if (!messaging || tokens.length === 0) return { success: 0, failure: 0 };
  let success = 0;
  let failure = 0;
  try {
    const unique = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
    // Chunk by 500 (FCM limit for sendEachForMulticast); we use sendEach in chunks of 100
    const chunkSize = 100;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const res = await messaging.sendEach(chunk.map((t) => buildMessage(t, payload)));
      res.responses.forEach((r, idx) => {
        if (r.success) {
          success += 1;
          return;
        }
        failure += 1;
        const code = r.error?.code;
        if (isInvalidTokenError(code)) onInvalid?.(chunk[idx]!);
      });
    }
  } catch (err) {
    log.warn('sendToTokens failed', err);
  }
  return { success, failure };
}

export async function sendToTopic(
  topic: string,
  payload: PushPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!messaging) return { ok: false, error: 'Firebase Admin not configured' };
  const t = topic.trim();
  if (!t) return { ok: false, error: 'Empty topic' };
  try {
    const data: PushData = { ...(payload.data ?? {}) };
    for (const [k, v] of Object.entries(data)) data[k] = String(v ?? '');

    if (payload.silent) {
      await messaging.send({
        topic: t,
        data: { ...data, type: data.type || 'unread_sync' },
        android: { priority: 'high' },
        apns: {
          headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
          payload: { aps: { 'content-available': 1 } },
        },
      });
    } else {
      await messaging.send({
        topic: t,
        notification: { title: payload.title, body: payload.body },
        data: { ...data, type: data.type || 'broadcast' },
        android: {
          priority: 'high',
          notification: { channelId: 'be_ther_alerts' },
        },
        apns: {
          payload: { aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' } },
        },
      });
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Topic send failed';
    log.warn('sendToTopic failed', { err, topic: t });
    return { ok: false, error: message };
  }
}

export { BROADCAST_TOPIC, cityTopicSlug };
