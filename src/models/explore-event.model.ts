import { Schema, model } from 'mongoose';

const exploreEventSchema = new Schema(
  {
    title: { type: String, required: true },
    location: { type: String, required: true },
    country: { type: String, required: true },
    type: { type: String, enum: ['event', 'place', 'concert'], required: true },
    image: { type: String, required: true },
    date: { type: String, required: true },
    venue: { type: String, required: true },
    ticketUrl: { type: String },
    attendees: { type: Number, default: 0 },
    trending: { type: Boolean, default: false },
  },
  { timestamps: true },
);

exploreEventSchema.index({ type: 1, trending: -1 });

export const ExploreEventModel = model('ExploreEvent', exploreEventSchema);
