import { Schema, model } from 'mongoose';

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['star', 'wishlist', 'calendar'], required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post' },
    read: { type: Boolean, default: false },
    mutualStar: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const NotificationModel = model('Notification', notificationSchema);
