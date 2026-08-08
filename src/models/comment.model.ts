import { Schema, model } from 'mongoose';

const commentSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    likesCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

commentSchema.index({ postId: 1, createdAt: -1 });

export const CommentModel = model('Comment', commentSchema);
