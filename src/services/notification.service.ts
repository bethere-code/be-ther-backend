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
  | 'calendar';

export type CreateNotificationInput = {
  userId: Types.ObjectId | string;
  type: NotificationType;
  actorUserId: Types.ObjectId | string;
  postId?: Types.ObjectId | string;
  mutualFollow?: boolean;
};

function pushCopy(
  type: NotificationType,
  actorLabel: string,
): { title: string; body: string } | null {
  const name = actorLabel.trim() || 'Someone';
  switch (type) {
    case 'wishlist':
      return { title: 'BE THER', body: `${name} added your event to their wishlist` };
    case 'calendar':
      return { title: 'BE THER', body: `${name} added your event to their calendar` };
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
      const actor = await UserModel.findById(actorId)
        .select('username displayName')
        .lean();
      const label =
        String(actor?.displayName ?? '').trim() ||
        String(actor?.username ?? '').trim() ||
        'Someone';
      const copy = pushCopy(input.type, label);
      if (!copy) return;
      await sendToUser(recipientId, {
        title: copy.title,
        body: copy.body,
        data: {
          type: 'social',
          notificationId: String(doc._id),
          kind: input.type,
          postId: input.postId ? String(input.postId) : '',
          username: String(actor?.username ?? ''),
        },
      });
    } catch {
      // Ignored — push is best-effort.
    }
  })();
}
