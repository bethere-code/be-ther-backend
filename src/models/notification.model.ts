import { Schema, model } from 'mongoose';

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // 'star' kept so existing notification documents still validate.
    type: {
      type: String,
      enum: [
        'follow',
        'follow_request',
        'follow_request_accepted',
        'follow_request_accepted_owner',
        'follow_request_rejected_owner',
        'star',
        'wishlist',
        'calendar',
        'like',
        'comment',
      ],
      required: true,
    },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post' },
    /** Last FCM send for this row (like throttle). */
    lastPushAt: { type: Date },
    read: { type: Boolean, default: false },
    mutualFollow: { type: Boolean, default: false },
    /** @deprecated Use mutualFollow. Kept for older notification rows. */
    mutualStar: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
// One in-app row per author + liker + event.
notificationSchema.index(
  { userId: 1, actorUserId: 1, postId: 1 },
  { unique: true, partialFilterExpression: { type: 'like' } },
);

export const NotificationModel = model('Notification', notificationSchema);
