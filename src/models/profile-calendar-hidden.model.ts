import { Schema, model } from 'mongoose';

/** Posts hidden from a user's profile; author-hidden posts also leave feed/explore/search. */
const profileCalendarHiddenSchema = new Schema(
  {
    profileUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
  },
  { timestamps: true },
);

profileCalendarHiddenSchema.index({ profileUserId: 1, postId: 1 }, { unique: true });

export const ProfileCalendarHiddenModel = model('ProfileCalendarHidden', profileCalendarHiddenSchema);
