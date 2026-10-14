import { createPublicKey } from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { Env } from '../config/env.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const KEYS_TTL_MS = 6 * 60 * 60 * 1000;

type AppleJwk = { kid?: string; kty: string; n: string; e: string; [k: string]: unknown };

let keysCache: { at: number; keys: AppleJwk[] } | null = null;

async function appleKeys(forceRefresh: boolean): Promise<AppleJwk[]> {
  if (!forceRefresh && keysCache && Date.now() - keysCache.at < KEYS_TTL_MS) {
    return keysCache.keys;
  }
  const res = await fetch(`${APPLE_ISSUER}/auth/keys`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('Could not reach Apple');
  const body = (await res.json()) as { keys?: AppleJwk[] };
  keysCache = { at: Date.now(), keys: body.keys ?? [] };
  return keysCache.keys;
}

export type AppleIdentity = {
  sub: string;
  email?: string;
  isPrivateEmail: boolean;
};

export async function verifyAppleIdToken(env: Env, identityToken: string): Promise<AppleIdentity> {
  const kid = jwt.decode(identityToken, { complete: true })?.header.kid;
  if (!kid) throw new Error('Invalid Apple token');
  // Apple rotates keys; refetch once when the kid is unknown.
  const jwk =
    (await appleKeys(false)).find((k) => k.kid === kid) ??
    (await appleKeys(true)).find((k) => k.kid === kid);
  if (!jwk) throw new Error('Invalid Apple token');

  const payload = jwt.verify(identityToken, createPublicKey({ key: jwk, format: 'jwk' }), {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    audience: env.APPLE_BUNDLE_ID,
  }) as jwt.JwtPayload;
  if (!payload.sub) throw new Error('Invalid Apple token');

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    isPrivateEmail: payload.is_private_email === true || payload.is_private_email === 'true',
  };
}

/** ES256 client secret for Apple's token endpoints; null until the .p8 key is configured. */
function appleClientSecret(env: Env): string | null {
  if (!env.IOS_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) return null;
  return jwt.sign({}, env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'), {
    algorithm: 'ES256',
    keyid: env.APPLE_KEY_ID,
    issuer: env.IOS_TEAM_ID,
    audience: APPLE_ISSUER,
    subject: env.APPLE_BUNDLE_ID,
    expiresIn: '5m',
  });
}

async function postAppleForm(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${APPLE_ISSUER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Trade the one-time authorization code for a refresh token (kept only for revocation). */
export async function exchangeAppleAuthCode(env: Env, code: string): Promise<string | null> {
  const secret = appleClientSecret(env);
  if (!secret) return null;
  const res = await postAppleForm('/auth/token', {
    client_id: env.APPLE_BUNDLE_ID,
    client_secret: secret,
    code,
    grant_type: 'authorization_code',
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { refresh_token?: string };
  return body.refresh_token ?? null;
}

export async function revokeAppleToken(env: Env, refreshToken: string): Promise<boolean> {
  const secret = appleClientSecret(env);
  if (!secret) return false;
  const res = await postAppleForm('/auth/revoke', {
    client_id: env.APPLE_BUNDLE_ID,
    client_secret: secret,
    token: refreshToken,
    token_type_hint: 'refresh_token',
  });
  return res.ok;
}
