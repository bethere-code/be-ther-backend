import { Types } from 'mongoose';

import { NotificationModel } from '../models/notification.model.js';
import { UserModel } from '../models/user.model.js';
import { sendToUser } from './fcm.service.js';

export type NotificationType =
  | 'follow'
  | 'follow_request'
  | 'follow_request_accepted'
  | 'follow_request_accepted_owner'
  | 'follow_request_rejected_owner'
  | 'star'
  | 'wishlist'
  | 'calendar'
  | 'like'
  | 'comment';

export type CreateNotificationInput = {
  userId: Types.ObjectId | string;
  type: NotificationType;
  actorUserId: Types.ObjectId | string;
  postId?: Types.ObjectId | string;
  mutualFollow?: boolean;
};

const LIKE_PUSH_COOLDOWN_MS = 2 * 60 * 60 * 1000;

const POST_EVENT_KINDS = new Set<NotificationType>([
  'calendar',
  'like',
  'comment',
  // legacy rows may still open an event:
  'wishlist',
]);

const FOLLOW_KINDS = new Set<NotificationType>([
  'follow',
  'star',
  'follow_request',
  'follow_request_accepted',
  'follow_request_accepted_owner',
  'follow_request_rejected_owner',
]);

function pushCopy(
  type: NotificationType,
  actorLabel: string,
): { title: string; body: string } | null {
  const name = actorLabel.trim() || 'Someone';
  switch (type) {
    case 'calendar':
      return { title: 'BE THER', body: `${name} added your event to their calendar` };
    case 'like':
      return { title: 'BE THER', body: `${name} liked your event` };
    case 'comment':
      return { title: 'BE THER', body: `${name} commented on your event` };
    case 'follow_request':
      return { title: 'BE THER', body: `${name} requested to follow you` };
    case 'follow_request_accepted':
      return { title: 'BE THER', body: `${name} accepted your follow request` };
    case 'follow_request_accepted_owner':
      return { title: 'BE THER', body: `You accepted ${name}'s follow request` };
    case 'follow_request_rejected_owner':
      return { title: 'BE THER', body: `You rejected ${name}'s follow request` };
    case 'follow':
    case 'star':
      return { title: 'BE THER', body: `${name} started following you` };
    default:
      return null;
  }
}

/** Shared FCM data for social + admin tap routing in the app. */
export function buildSocialPushData(input: {
  notificationId: string;
  kind: NotificationType;
  postId?: string;
  username?: string;
}): Record<string, string> {
  const postId = input.postId?.trim() ?? '';
  const username = input.username?.trim() ?? '';
  const data: Record<string, string> = {
    type: 'social',
    notificationId: input.notificationId,
    kind: input.kind,
    postId,
    username,
  };
  if (POST_EVENT_KINDS.has(input.kind) && postId) {
    data.screen = 'event';
    data.id = postId;
  } else if (FOLLOW_KINDS.has(input.kind) && username) {
    data.screen = 'profile';
    data.id = username;
  }
  return data;
}

export function shouldSkipLikePush(lastPushAt: Date | null | undefined, now = Date.now()): boolean {
  if (!lastPushAt) return false;
  return now - lastPushAt.getTime() < LIKE_PUSH_COOLDOWN_MS;
}

async function actorLabel(actorUserId: string): Promise<{ label: string; username: string }> {
  const actor = await UserModel.findById(actorUserId).select('username displayName').lean();
  const username = String(actor?.username ?? '').trim();
  const label =
    String(actor?.displayName ?? '').trim() || username || 'Someone';
  return { label, username };
}

async function fireSocialPush(
  recipientId: string,
  docId: string,
  type: NotificationType,
  actorUserId: string,
  postId?: string,
): Promise<void> {
  const { label, username } = await actorLabel(actorUserId);
  const copy = pushCopy(type, label);
  if (!copy) return;
  await sendToUser(recipientId, {
    title: copy.title,
    body: copy.body,
    data: buildSocialPushData({
      notificationId: docId,
      kind: type,
      postId: postId ? String(postId) : '',
      username,
    }),
  });
}

/**
 * Create in-app notification, then fire-and-forget FCM push.
 * Push failure never rolls back the DB row.
 */
export async function createAndPushNotification(
  input: CreateNotificationInput,
): Promise<void> {
  const doc = await NotificationModel.create({
    userId: input.userId,
    type: input.type,
    actorUserId: input.actorUserId,
    ...(input.postId ? { postId: input.postId } : {}),
    mutualFollow: Boolean(input.mutualFollow),
  });

  const actorId = String(input.actorUserId);
  const recipientId = String(input.userId);
  void (async () => {
    try {
      await fireSocialPush(
        recipientId,
        String(doc._id),
        input.type,
        actorId,
        input.postId ? String(input.postId) : undefined,
      );
    } catch {
      // Ignored — push is best-effort.
    }
  })();
}

/**
 * One Alerts row per (author, liker, event). Bump time on repeat likes.
 * FCM at most once per that trio per 2 hours.
 */
export async function upsertLikeAndPushNotification(
  input: CreateNotificationInput & { postId: Types.ObjectId | string },
): Promise<void> {
  const now = new Date();
  const doc = await NotificationModel.findOneAndUpdate(
    {
      userId: input.userId,
      actorUserId: input.actorUserId,
      postId: input.postId,
      type: 'like',
    },
    {
      $set: {
        read: false,
        createdAt: now,
        mutualFollow: Boolean(input.mutualFollow),
      },
      $setOnInsert: {
        userId: input.userId,
        actorUserId: input.actorUserId,
        postId: input.postId,
        type: 'like',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  if (!doc) return;

  const recipientId = String(input.userId);
  const actorId = String(input.actorUserId);
  const postId = String(input.postId);
  const docId = String(doc._id);

  if (shouldSkipLikePush(doc.lastPushAt as Date | undefined)) {
    return;
  }

  void (async () => {
    try {
      await fireSocialPush(recipientId, docId, 'like', actorId, postId);
      await NotificationModel.updateOne({ _id: doc._id }, { $set: { lastPushAt: new Date() } });
    } catch {
      // Ignored — push is best-effort.
    }
  })();
}
