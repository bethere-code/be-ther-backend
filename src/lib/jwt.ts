import jwt from 'jsonwebtoken';

import type { Env } from '../config/env.js';

export type AccessPayload = { sub: string; typ: 'access' };
export type RefreshPayload = { sub: string; typ: 'refresh'; ver: number };
export type AdminPayload = { sub: string; typ: 'admin' };

export function signAccessToken(env: Env, userId: string): string {
  const payload: AccessPayload = { sub: userId, typ: 'access' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL_SEC });
}

export function signAdminToken(env: Env, email: string): string {
  const payload: AdminPayload = { sub: email, typ: 'admin' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: 60 * 60 * 8 });
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

export function verifyAdminToken(env: Env, token: string): AdminPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & { typ?: string };
  if (decoded.typ !== 'admin' || typeof decoded.sub !== 'string') {
    throw new Error('Invalid admin token');
  }
  return { sub: decoded.sub, typ: 'admin' };
}

export function verifyRefreshToken(env: Env, token: string): RefreshPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as jwt.JwtPayload & { typ?: string; ver?: number };
  if (decoded.typ !== 'refresh' || typeof decoded.sub !== 'string' || typeof decoded.ver !== 'number') {
    throw new Error('Invalid refresh token');
  }
  return { sub: decoded.sub, typ: 'refresh', ver: decoded.ver };
}
