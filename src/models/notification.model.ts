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
      ],
      required: true,
    },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post' },
    read: { type: Boolean, default: false },
    mutualFollow: { type: Boolean, default: false },
    /** @deprecated Use mutualFollow. Kept for older notification rows. */
    mutualStar: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const NotificationModel = model('Notification', notificationSchema);
