import { Schema, model } from 'mongoose';

const calendarSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
  },
  { timestamps: true },
);

calendarSchema.index({ userId: 1, postId: 1 }, { unique: true });

export const CalendarModel = model('Calendar', calendarSchema);
