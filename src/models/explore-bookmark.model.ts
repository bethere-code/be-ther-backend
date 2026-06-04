import { Schema, model } from 'mongoose';

const exploreBookmarkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    exploreEventId: { type: Schema.Types.ObjectId, ref: 'ExploreEvent', required: true },
  },
  { timestamps: true },
);

exploreBookmarkSchema.index({ userId: 1, exploreEventId: 1 }, { unique: true });

export const ExploreBookmarkModel = model('ExploreBookmark', exploreBookmarkSchema);
