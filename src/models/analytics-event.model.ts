import { Schema, model, Types } from 'mongoose';

const analyticsEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['screen_time', 'auth'], required: true },
    occurredAt: { type: Date, required: true },
    screen: { type: String, default: '' },
    path: { type: String, default: '' },
    enteredAt: { type: Date },
    exitedAt: { type: Date },
    durationMs: { type: Number, min: 0 },
    exitReason: { type: String, default: '' },
    action: { type: String, enum: ['signup', 'login', 'logout', ''] },
  },
  { timestamps: false },
);

analyticsEventSchema.index({ userId: 1, occurredAt: -1 });
analyticsEventSchema.index({ type: 1, occurredAt: -1 });

export const AnalyticsEventModel = model('AnalyticsEvent', analyticsEventSchema);
export type AnalyticsEventId = Types.ObjectId;
