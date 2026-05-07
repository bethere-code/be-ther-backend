import { Schema, model } from 'mongoose';

const userSettingsSchema = new Schema(
  {
    isPrivateProfile: { type: Boolean, default: false },
    pushEnabled: { type: Boolean, default: true },
    calendarView: { type: String, enum: ['full', 'events-only'], default: 'full' },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    displayName: { type: String, required: true, trim: true },
    avatarUrl: { type: String, default: '' },
    bio: { type: String, default: '' },
    googleSub: { type: String, unique: true, sparse: true, index: true },
    emailVerified: { type: Boolean, default: false },
    authProvider: { type: String, enum: ['otp', 'password', 'google'], default: 'otp', index: true },
    /** bcrypt hash; absent for OAuth-only accounts */
    passwordHash: { type: String, default: '' },
    age: { type: Number, min: 1, max: 120 },
    starsReceived: { type: Number, default: 0 },
    placesVisited: { type: Number, default: 0 },
    eventsAttended: { type: Number, default: 0 },
    tokenVersion: { type: Number, default: 0 },
    settings: { type: userSettingsSchema, default: () => ({}) },
  },
  { timestamps: true },
);

userSchema.set('toJSON', {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transform: (_doc: unknown, ret: Record<string, any>) => {
    delete ret.passwordHash;
    return ret;
  },
});

export const UserModel = model('User', userSchema);
