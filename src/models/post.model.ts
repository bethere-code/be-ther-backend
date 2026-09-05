import { Schema, model, Types } from 'mongoose';

/** Structured venue / address from Google Places (or GPS reverse geocode). */
const eventLocationSchema = new Schema(
  {
    placeId: { type: String, default: '' },
    name: { type: String, default: '' },
    formattedAddress: { type: String, default: '' },
    locality: { type: String, default: '' },
    street: { type: String, default: '' },
    area: { type: String, default: '' },
    city: { type: String, default: '' },
    district: { type: String, default: '' },
    state: { type: String, default: '' },
    country: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    lat: { type: Number },
    lng: { type: Number },
  },
  { _id: false },
);

const latLngSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false },
);

const eventDetailsSchema = new Schema(
  {
    type: { type: String, enum: ['event', 'place', 'concert'] },
    date: { type: String },
    time: { type: String },
    venue: { type: String },
    ticketUrl: { type: String },
    /** Full broken-down place for future city/state/country filters. */
    eventLocation: { type: eventLocationSchema },
    /** Where the poster was when they created the post (device GPS). */
    userLocation: { type: latLngSchema },
  },
  { _id: false },
);

const postSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    location: { type: String, required: true },
    status: { type: String, enum: ['been', 'going', 'interested'], required: true },
    imageUrl: { type: String, required: true },
    /**
     * Cover width÷height as uploaded (e.g. 1.5 = 3:2, 16/9, 4/3, 0.75 = default 3:4).
     * Missing on legacy posts — clients fall back.
     */
    coverAspectRatio: { type: Number, min: 0.4, max: 3.5 },
    caption: { type: String, default: '' },
    likesCount: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },
    calendarCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
    isPrivate: { type: Boolean, default: false },
    usesDefaultCover: { type: Boolean, default: false },
    editedAt: { type: Date },
    taggedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    eventDetails: { type: eventDetailsSchema },
  },
  { timestamps: true },
);

postSchema.index({ createdAt: -1, _id: -1 });
postSchema.index({ authorId: 1, createdAt: -1 });
postSchema.index({ isPrivate: 1, createdAt: -1, _id: -1 });
// App stores ISO YYYY-MM-DD — used for explore upcoming filter + sort.
postSchema.index({
  'eventDetails.date': 1,
  likesCount: -1,
  commentsCount: -1,
  createdAt: -1,
  _id: -1,
});
postSchema.index({ 'eventDetails.eventLocation.city': 1 });
postSchema.index({ 'eventDetails.eventLocation.state': 1 });
postSchema.index({ 'eventDetails.eventLocation.country': 1 });
// Search candidate pulls (visibility + recency).
postSchema.index({ isPrivate: 1, authorId: 1, createdAt: -1, _id: -1 });

export const PostModel = model('Post', postSchema);
export type PostId = Types.ObjectId;
