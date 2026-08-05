import { Schema, model } from 'mongoose';

const calendarSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    /** Viewer RSVP on this event. Older rows without status are treated as going. */
    status: {
      type: String,
      enum: ['interested', 'going'],
      default: 'going',
      index: true,
    },
  },
  { timestamps: true },
);

calendarSchema.index({ userId: 1, postId: 1 }, { unique: true });

export const CalendarModel = model('Calendar', calendarSchema);
