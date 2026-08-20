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
    /** Present on auth events — which phone/app did login/signup/logout. */
    device: {
      type: new Schema(
        {
          platform: { type: String, default: '' },
          model: { type: String, default: '' },
          os: { type: String, default: '' },
          appVersion: { type: String, default: '' },
          appBuild: { type: String, default: '' },
          deviceId: { type: String, default: '' },
          location: {
            type: new Schema(
              {
                lat: { type: Number },
                lng: { type: Number },
                accuracyM: { type: Number },
              },
              { _id: false },
            ),
          },
        },
        { _id: false },
      ),
    },
  },
  { timestamps: false },
);

analyticsEventSchema.index({ userId: 1, occurredAt: -1 });
analyticsEventSchema.index({ type: 1, occurredAt: -1 });

export const AnalyticsEventModel = model('AnalyticsEvent', analyticsEventSchema);
export type AnalyticsEventId = Types.ObjectId;
