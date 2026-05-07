import { Schema, model, Types } from 'mongoose';

const eventDetailsSchema = new Schema(
  {
    type: { type: String, enum: ['event', 'place', 'concert'] },
    date: { type: String },
    venue: { type: String },
    ticketUrl: { type: String },
  },
  { _id: false },
);

const postSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    location: { type: String, required: true },
    country: { type: String, required: true },
    status: { type: String, enum: ['been', 'going'], required: true },
    imageUrl: { type: String, required: true },
    caption: { type: String, default: '' },
    likesCount: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },
    isPrivate: { type: Boolean, default: false },
    taggedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    eventDetails: { type: eventDetailsSchema },
  },
  { timestamps: true },
);

postSchema.index({ createdAt: -1, _id: -1 });

export const PostModel = model('Post', postSchema);
export type PostId = Types.ObjectId;
