import { Schema, model } from 'mongoose';

const commentLikeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    commentId: { type: Schema.Types.ObjectId, ref: 'Comment', required: true },
  },
  { timestamps: true },
);

commentLikeSchema.index({ userId: 1, commentId: 1 }, { unique: true });
commentLikeSchema.index({ commentId: 1 });

export const CommentLikeModel = model('CommentLike', commentLikeSchema);
