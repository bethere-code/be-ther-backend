import { Schema, model } from 'mongoose';

/**
 * Directed follow edge (Instagram / X style).
 * followerId follows followingId.
 * status: pending = private-profile request; accepted = real follow.
 * Missing status on legacy docs is treated as accepted.
 */
const followSchema = new Schema(
  {
    followerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    followingId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'accepted'],
      default: 'accepted',
      index: true,
    },
  },
  { timestamps: true },
);

followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });

export const FollowModel = model('Follow', followSchema);

/** Merge into Follow queries so pending requests never count as follows. */
export function acceptedOnly<T extends Record<string, unknown>>(
  filter: T,
): T & { status: { $ne: 'pending' } } {
  return { ...filter, status: { $ne: 'pending' } };
}
