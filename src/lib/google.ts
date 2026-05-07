import { OAuth2Client } from 'google-auth-library';

import type { Env } from '../config/env.js';

export async function verifyGoogleIdToken(env: Env, idToken: string): Promise<{ sub: string; email?: string; name?: string; picture?: string }> {
  const client = new OAuth2Client(env.GOOGLE_WEB_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_WEB_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error('Invalid Google token');
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}
