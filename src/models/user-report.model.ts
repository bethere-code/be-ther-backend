import { Schema, model } from 'mongoose';

export const USER_REPORT_REASONS = [
  'spam',
  'harassment',
  'impersonation',
  'other',
] as const;

export type UserReportReason = (typeof USER_REPORT_REASONS)[number];

const userReportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reportedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: USER_REPORT_REASONS, required: true },
    details: { type: String, default: '' },
  },
  { timestamps: true },
);

userReportSchema.index({ reporterId: 1, reportedUserId: 1 }, { unique: true });

export const UserReportModel = model('UserReport', userReportSchema);
