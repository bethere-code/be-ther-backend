import { Schema, model } from 'mongoose';

const userSettingsSchema = new Schema(
  {
    isPrivateProfile: { type: Boolean, default: false },
    pushEnabled: { type: Boolean, default: true },
    calendarView: { type: String, enum: ['full', 'events-only'], default: 'full' },
  },
  { _id: false },
);

const devicePermissionEntrySchema = new Schema(
  {
    /** Whether the OS permission is effectively enabled (granted / limited / provisional). */
    granted: { type: Boolean, default: false },
    status: {
      type: String,
      enum: [
        'granted',
        'denied',
        'limited',
        'provisional',
        'permanently_denied',
        'restricted',
        'unknown',
      ],
      default: 'unknown',
    },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const devicePermissionsSchema = new Schema(
  {
    notification: { type: devicePermissionEntrySchema, default: () => ({}) },
    location: { type: devicePermissionEntrySchema, default: () => ({}) },
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
    /** Denormalized follow graph counts — updated on follow/unfollow (O(1) profile reads). */
    followersCount: { type: Number, default: 0, min: 0 },
    followingCount: { type: Number, default: 0, min: 0 },
    /** Denormalized count of posts/events created by this user. */
    eventsCount: { type: Number, default: 0, min: 0 },
    /** @deprecated Legacy “star” counter; kept for old docs. Prefer followersCount. */
    starsReceived: { type: Number, default: 0 },
    placesVisited: { type: Number, default: 0 },
    eventsAttended: { type: Number, default: 0 },
    tokenVersion: { type: Number, default: 0 },
    settings: { type: userSettingsSchema, default: () => ({}) },
    devicePermissions: { type: devicePermissionsSchema, default: () => ({}) },
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
