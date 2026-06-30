import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';

import type { Env } from '../config/env.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js';
import { sendOtpEmail } from '../lib/mail.js';
import { verifyGoogleIdToken } from '../lib/google.js';
import { savePublicObject } from '../lib/storage.js';
import { OtpChallengeModel } from '../models/otp-challenge.model.js';
import { UserModel } from '../models/user.model.js';

export const USERNAME_SIGNUP_REGEX = /^[a-z0-9]{3,32}$/;

function emailLocalPart(email: string): string {
  return email.split('@')[0]?.replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'user';
}

function firstNameFromGoogleName(name?: string): string | undefined {
  const raw = name?.trim();
  if (!raw) return undefined;
  const first = raw.split(/\s+/)[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

async function findUserByIdentifier(identifier: string) {
  const normalized = normalizeIdentifier(identifier);
  if (normalized.includes('@')) {
    return UserModel.findOne({ email: normalized });
  }
  return UserModel.findOne({ username: normalized });
}

async function uniqueUsername(base: string): Promise<string> {
  let candidate = base.slice(0, 20);
  for (let i = 0; i < 20; i += 1) {
    const exists = await UserModel.exists({ username: candidate });
    if (!exists) return candidate;
    candidate = `${base.slice(0, 12)}_${nanoid(6)}`;
  }
  return `${base.slice(0, 8)}_${nanoid(10)}`;
}

export async function requestOtp(env: Env, email: string): Promise<void> {
  const normalized = email.toLowerCase().trim();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MIN * 60 * 1000);

  await OtpChallengeModel.deleteMany({ email: normalized });
  await OtpChallengeModel.create({
    email: normalized,
    codeHash,
    expiresAt,
    attempts: 0,
    purpose: 'login',
  });

  await sendOtpEmail(env, normalized, code);
}

export async function requestLoginOtp(
  env: Env,
  identifier: string,
): Promise<{ destinationLabel: string }> {
  const user = await findUserByIdentifier(identifier);
  if (!user) {
    throw new Error('No account found with this email or username');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MIN * 60 * 1000);

  await OtpChallengeModel.deleteMany({ email: user.email });
  await OtpChallengeModel.create({
    email: user.email,
    codeHash,
    expiresAt,
    attempts: 0,
    purpose: 'login',
  });

  await sendOtpEmail(env, user.email, code);
  return { destinationLabel: user.email };
}

export interface SignupRequestPayload {
  displayName: string;
  username: string;
  email: string;
  password: string;
  age?: number | null;
}

export interface SignupAvailabilityResult {
  username?: { available: boolean; reason?: string };
  email?: { available: boolean; reason?: string };
}

export async function checkSignupAvailability(input: {
  username?: string;
  email?: string;
}): Promise<SignupAvailabilityResult> {
  const result: SignupAvailabilityResult = {};

  if (input.username != null) {
    console.log('input.username', input.username);
    const username = input.username.toLowerCase().trim();
    if (username.length < 3) {
      result.username = { available: false, reason: 'Username must be at least 3 characters' };
    } else if (!USERNAME_SIGNUP_REGEX.test(username)) {
      result.username = { available: false, reason: 'Username: lowercase letters and digits only' };
    } else {
      console.log('username', username);
      const exists = await UserModel.exists({ username });
      console.log('exists', exists);
      result.username = exists ? { available: false, reason: 'Username already exists' } : { available: true };
    }
  }

  if (input.email != null) {
    const email = input.email.toLowerCase().trim();
    if (!email) {
      result.email = { available: false, reason: 'Email is required' };
    } else {
      const exists = await UserModel.exists({ email });
      result.email = exists ? { available: false, reason: 'Email already exists' } : { available: true };
    }
  }

  return result;
}

export async function requestSignupOtp(env: Env, payload: SignupRequestPayload): Promise<void> {
  const email = payload.email.toLowerCase().trim();
  const username = payload.username.toLowerCase().trim();
  const displayName = payload.displayName.trim();

  if (!USERNAME_SIGNUP_REGEX.test(username)) {
    throw new Error('Username must be 3–32 lowercase letters or digits only');
  }

  const emailTaken = await UserModel.exists({ email });
  if (emailTaken) {
    throw new Error('Email is already registered');
  }
  const usernameTaken = await UserModel.exists({ username });
  if (usernameTaken) {
    throw new Error('Username is already taken');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const passwordHash = await bcrypt.hash(payload.password, 10);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MIN * 60 * 1000);

  await OtpChallengeModel.deleteMany({ email });
  await OtpChallengeModel.create({
    email,
    codeHash,
    expiresAt,
    attempts: 0,
    purpose: 'signup',
    signupDisplayName: displayName,
    signupUsername: username,
    signupPasswordHash: passwordHash,
    ...(payload.age != null && payload.age > 0 ? { signupAge: payload.age } : {}),
  });

  await sendOtpEmail(env, email, code);
}

export async function verifyOtp(env: Env, email: string, code: string): Promise<{ accessToken: string; refreshToken: string; user: unknown }> {
  const normalized = email.toLowerCase().trim();
  const challenge = await OtpChallengeModel.findOne({ email: normalized }).sort({ createdAt: -1 });
  if (!challenge) {
    throw new Error('No active code for this email');
  }
  if (challenge.purpose === 'signup') {
    throw new Error('This code was sent for sign-up. Finish verification on the sign-up screen.');
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    throw new Error('Code expired');
  }
  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw new Error('Too many attempts');
  }
  const ok = await bcrypt.compare(code, challenge.codeHash);
  challenge.attempts += 1;
  await challenge.save();
  if (!ok) {
    throw new Error('Invalid code');
  }

  let user = await UserModel.findOne({ email: normalized });
  if (!user) {
    const base = emailLocalPart(normalized);
    const uname = await uniqueUsername(base);
    user = await UserModel.create({
      email: normalized,
      username: uname,
      displayName: uname,
      emailVerified: true,
      authProvider: 'otp',
    });
  } else {
    user.emailVerified = true;
    await user.save();
  }

  await OtpChallengeModel.deleteMany({ email: normalized });

  const accessToken = signAccessToken(env, String(user._id));
  const refreshToken = signRefreshToken(env, String(user._id), user.tokenVersion);

  return { accessToken, refreshToken, user: user.toJSON() };
}

export async function verifyLoginOtp(
  env: Env,
  identifier: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; user: unknown }> {
  const user = await findUserByIdentifier(identifier);
  if (!user) {
    throw new Error('No account found with this email or username');
  }
  const normalized = user.email.toLowerCase().trim();
  const challenge = await OtpChallengeModel.findOne({ email: normalized }).sort({
    createdAt: -1,
  });
  if (!challenge) {
    throw new Error('No active code for this account');
  }
  if (challenge.purpose === 'signup') {
    throw new Error(
      'This code was sent for sign-up. Finish verification on the sign-up screen.',
    );
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    throw new Error('Code expired');
  }
  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw new Error('Too many attempts');
  }
  const ok = await bcrypt.compare(code, challenge.codeHash);
  challenge.attempts += 1;
  await challenge.save();
  if (!ok) {
    throw new Error('Invalid code');
  }

  user.emailVerified = true;
  await user.save();
  await OtpChallengeModel.deleteMany({ email: normalized });

  const accessToken = signAccessToken(env, String(user._id));
  const refreshToken = signRefreshToken(env, String(user._id), user.tokenVersion);
  return { accessToken, refreshToken, user: user.toJSON() };
}

export async function loginWithPassword(
  env: Env,
  identifier: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string; user: unknown }> {
  const user = await findUserByIdentifier(identifier);
  if (!user) {
    throw new Error('Invalid credentials');
  }
  if (user.authProvider === 'google' && !user.passwordHash) {
    throw new Error('Use Google sign-in for this account');
  }
  if (!user.passwordHash) {
    throw new Error('Password login is not available for this account');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new Error('Invalid credentials');
  }

  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }

  const accessToken = signAccessToken(env, String(user._id));
  const refreshToken = signRefreshToken(env, String(user._id), user.tokenVersion);
  return { accessToken, refreshToken, user: user.toJSON() };
}

export async function verifySignupOtp(
  env: Env,
  email: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; user: unknown }> {
  const normalized = email.toLowerCase().trim();
  const challenge = await OtpChallengeModel.findOne({ email: normalized }).sort({ createdAt: -1 });
  if (!challenge || challenge.purpose !== 'signup') {
    throw new Error('No active sign-up verification for this email');
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    throw new Error('Code expired');
  }
  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw new Error('Too many attempts');
  }

  const ok = await bcrypt.compare(code, challenge.codeHash);
  challenge.attempts += 1;
  await challenge.save();
  if (!ok) {
    throw new Error('Invalid code');
  }

  if (!challenge.signupUsername || !challenge.signupPasswordHash || !challenge.signupDisplayName) {
    throw new Error('Sign-up data is incomplete');
  }

  const emailTaken = await UserModel.exists({ email: normalized });
  if (emailTaken) {
    await OtpChallengeModel.deleteMany({ email: normalized });
    throw new Error('Email is already registered');
  }
  const usernameTaken = await UserModel.exists({ username: challenge.signupUsername });
  if (usernameTaken) {
    await OtpChallengeModel.deleteMany({ email: normalized });
    throw new Error('Username is no longer available');
  }

  const user = await UserModel.create({
    email: normalized,
    username: challenge.signupUsername,
    displayName: challenge.signupDisplayName,
    emailVerified: true,
    authProvider: 'password',
    passwordHash: challenge.signupPasswordHash,
    ...(challenge.signupAge != null ? { age: challenge.signupAge } : {}),
  });

  await OtpChallengeModel.deleteMany({ email: normalized });

  const accessToken = signAccessToken(env, String(user._id));
  const refreshToken = signRefreshToken(env, String(user._id), user.tokenVersion);

  return { accessToken, refreshToken, user: user.toJSON() };
}

export async function loginWithGoogle(env: Env, idToken: string): Promise<{ accessToken: string; refreshToken: string; user: unknown }> {
  const google = await verifyGoogleIdToken(env, idToken);
  if (!google.email) {
    throw new Error('Google account has no email');
  }

  let user = await UserModel.findOne({ googleSub: google.sub });
  if (!user) {
    user = await UserModel.findOne({ email: google.email.toLowerCase() });
    if (user) {
      user.googleSub = google.sub;
      user.emailVerified = true;
      user.authProvider = user.authProvider || 'google';
      if (google.picture && !user.avatarUrl) user.avatarUrl = google.picture;
      const firstName = firstNameFromGoogleName(google.name);
      if (firstName && user.displayName === user.username) user.displayName = firstName;
      await user.save();
    } else {
      const base = emailLocalPart(google.email);
      const username = await uniqueUsername(base);
      const firstName = firstNameFromGoogleName(google.name);
      let avatarUrl = '';
      if (google.picture) {
        try {
          const res = await fetch(google.picture);
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = res.headers.get('content-type') || 'image/jpeg';
          avatarUrl = await savePublicObject(env, buf, mime);
        } catch {
          avatarUrl = google.picture;
        }
      }
      user = await UserModel.create({
        email: google.email.toLowerCase(),
        username,
        displayName: firstName ?? username,
        avatarUrl,
        googleSub: google.sub,
        emailVerified: true,
        authProvider: 'google',
        passwordHash: '',
      });
    }
  }

  const accessToken = signAccessToken(env, String(user!._id));
  const refreshToken = signRefreshToken(env, String(user!._id), user!.tokenVersion);

  return { accessToken, refreshToken, user: user!.toJSON() };
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const payload = verifyRefreshToken(env, refreshToken);
  const user = await UserModel.findById(payload.sub);
  if (!user || user.tokenVersion !== payload.ver) {
    throw new Error('Invalid refresh token');
  }
  return {
    accessToken: signAccessToken(env, String(user._id)),
    refreshToken: signRefreshToken(env, String(user._id), user.tokenVersion),
  };
}
