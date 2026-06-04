import { Schema, model } from 'mongoose';

export type PostReportType = 'event_cancelled' | 'spam' | 'bug';

const postReportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    type: {
      type: String,
      enum: ['event_cancelled', 'spam', 'bug'],
      required: true,
    },
    details: { type: String, default: '' },
  },
  { timestamps: true },
);

postReportSchema.index({ reporterId: 1, postId: 1, type: 1 }, { unique: true });

export const PostReportModel = model('PostReport', postReportSchema);
