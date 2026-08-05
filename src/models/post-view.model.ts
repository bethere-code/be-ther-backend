import { Schema, model } from 'mongoose';

/** One unique view per user per post. Used to bump Post.viewCount once. */
const postViewSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true },
);

postViewSchema.index({ postId: 1, userId: 1 }, { unique: true });

export const PostViewModel = model('PostView', postViewSchema);
