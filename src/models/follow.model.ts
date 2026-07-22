import { Schema, model } from 'mongoose';

/**
 * Directed follow edge (Instagram / X style).
 * followerId follows followingId.
 */
const followSchema = new Schema(
  {
    followerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    followingId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true },
);

followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });

export const FollowModel = model('Follow', followSchema);
