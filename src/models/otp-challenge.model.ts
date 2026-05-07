import { Schema, model } from 'mongoose';

const otpChallengeSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, required: true, default: 0 },
    purpose: { type: String, enum: ['login', 'signup'], default: 'login', index: true },
    /** Populated when purpose === 'signup' */
    signupDisplayName: { type: String, trim: true },
    signupUsername: { type: String, lowercase: true, trim: true },
    signupPasswordHash: { type: String },
    signupAge: { type: Number, min: 1, max: 120 },
  },
  { timestamps: true },
);

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpChallengeModel = model('OtpChallenge', otpChallengeSchema);
