/** Run: npx tsx src/lib/apple.check.ts — offline; Apple endpoints are stubbed. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { Env } from '../config/env.js';
import { exchangeAppleAuthCode, revokeAppleToken, verifyAppleIdToken } from './apple.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const appleJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  if (path === '/auth/keys') return Response.json({ keys: [appleJwk] });
  const form = new URLSearchParams(String(init?.body));
  const secret = jwt.verify(form.get('client_secret') ?? '', ec.publicKey, {
    algorithms: ['ES256'],
    issuer: 'TEAM123',
    audience: 'https://appleid.apple.com',
    subject: 'com.bether.app',
  });
  assert.ok(secret);
  assert.equal(form.get('client_id'), 'com.bether.app');
  if (path === '/auth/token') {
    assert.equal(form.get('code'), 'code-1');
    return Response.json({ refresh_token: 'refresh-1' });
  }
  if (path === '/auth/revoke') {
    assert.equal(form.get('token'), 'refresh-1');
    return new Response(null, { status: 200 });
  }
  throw new Error(`unexpected fetch ${path}`);
}) as typeof fetch;

const env = { APPLE_BUNDLE_ID: 'com.bether.app' } as Env;

function appleToken(
  overrides: { audience?: string; issuer?: string; keyid?: string; exp?: number } = {},
  key = rsa.privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      email: 'abc@privaterelay.appleid.com',
      is_private_email: 'true',
      exp: overrides.exp ?? now + 300,
    },
    key,
    {
      algorithm: 'RS256',
      keyid: overrides.keyid ?? 'k1',
      issuer: overrides.issuer ?? 'https://appleid.apple.com',
      audience: overrides.audience ?? 'com.bether.app',
      subject: '001234.apple-user',
    },
  );
}

assert.deepEqual(await verifyAppleIdToken(env, appleToken()), {
  sub: '001234.apple-user',
  email: 'abc@privaterelay.appleid.com',
  isPrivateEmail: true,
});
await assert.rejects(verifyAppleIdToken(env, appleToken({ audience: 'com.other.app' })));
await assert.rejects(verifyAppleIdToken(env, appleToken({ issuer: 'https://evil.example' })));
await assert.rejects(verifyAppleIdToken(env, appleToken({ exp: Math.floor(Date.now() / 1000) - 60 })));
await assert.rejects(verifyAppleIdToken(env, appleToken({ keyid: 'unknown' })));
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
await assert.rejects(verifyAppleIdToken(env, appleToken({}, forger)));
await assert.rejects(verifyAppleIdToken(env, 'not-a-jwt'));

// Without the .p8 key: no Apple calls, login keeps working.
assert.equal(await exchangeAppleAuthCode(env, 'code-1'), null);
assert.equal(await revokeAppleToken(env, 'refresh-1'), false);

const pem = ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const withKey = {
  ...env,
  IOS_TEAM_ID: 'TEAM123',
  APPLE_KEY_ID: 'KEY123',
  // Same shape as the one-line value in .env.production.
  APPLE_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
} as Env;
assert.equal(await exchangeAppleAuthCode(withKey, 'code-1'), 'refresh-1');
assert.equal(await revokeAppleToken(withKey, 'refresh-1'), true);

console.log('apple.check OK');
