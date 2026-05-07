import { Schema, model } from 'mongoose';

const profileStarSchema = new Schema(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

profileStarSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

export const ProfileStarModel = model('ProfileStar', profileStarSchema);
