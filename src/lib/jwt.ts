import jwt from 'jsonwebtoken';

import type { Env } from '../config/env.js';

export type AccessPayload = { sub: string; typ: 'access' };
export type RefreshPayload = { sub: string; typ: 'refresh'; ver: number };

export function signAccessToken(env: Env, userId: string): string {
  const payload: AccessPayload = { sub: userId, typ: 'access' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL_SEC });
}

export function signRefreshToken(env: Env, userId: string, ver: number): string {
  const payload: RefreshPayload = { sub: userId, typ: 'refresh', ver };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_TTL_SEC });
}

export function verifyAccessToken(env: Env, token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & { typ?: string };
  if (decoded.typ !== 'access' || typeof decoded.sub !== 'string') {
    throw new Error('Invalid access token');
  }
  return { sub: decoded.sub, typ: 'access' };
}

export function verifyRefreshToken(env: Env, token: string): RefreshPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as jwt.JwtPayload & { typ?: string; ver?: number };
  if (decoded.typ !== 'refresh' || typeof decoded.sub !== 'string' || typeof decoded.ver !== 'number') {
    throw new Error('Invalid refresh token');
  }
  return { sub: decoded.sub, typ: 'refresh', ver: decoded.ver };
}
