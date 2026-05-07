import { Schema, model } from 'mongoose';

const bookmarkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
  },
  { timestamps: true },
);

bookmarkSchema.index({ userId: 1, postId: 1 }, { unique: true });

export const BookmarkModel = model('Bookmark', bookmarkSchema);
