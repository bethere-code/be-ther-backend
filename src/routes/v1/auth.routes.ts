import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Env } from '../../config/env.js';
import {
  checkSignupAvailability,
  loginWithPassword,
  loginWithGoogle,
  refreshTokens,
  requestLoginOtp,
  requestOtp,
  verifyLoginOtp,
  requestSignupOtp,
  verifyOtp,
  verifySignupOtp,
} from '../../services/auth.service.js';

const otpRequestSchema = z.object({ email: z.string().email() });
const otpVerifySchema = z.object({ email: z.string().email(), code: z.string().min(4).max(8) });
const loginOtpRequestSchema = z.object({
  identifier: z.string().trim().min(3),
});
const loginOtpVerifySchema = z.object({
  identifier: z.string().trim().min(3),
  code: z.string().length(6),
});
const loginPasswordSchema = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(8),
});

const signupPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/^.{8,}$/, 'Password must be at least 8 characters');

const signupRequestOtpSchema = z.object({
  displayName: z.string().trim().min(1, 'Name is required').max(80),
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9]+$/, 'Username: lowercase letters and digits only, no spaces'),
  email: z.string().email(),
  password: signupPasswordSchema,
  age: z.coerce.number().int().min(1).max(120).optional().nullable(),
});

const signupVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});
const signupAvailabilitySchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
});
const googleSchema = z.object({ idToken: z.string().min(10) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });

export async function registerAuthV1Routes(app: FastifyInstance, env: Env): Promise<void> {
  app.post('/api/v1/auth/login/otp/request', async (req, reply) => {
    const parsed = loginOtpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const data = await requestLoginOtp(env, parsed.data.identifier);
      return reply.send({ ok: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send code';
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  app.post('/api/v1/auth/login/otp/verify', async (req, reply) => {
    const parsed = loginOtpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const data = await verifyLoginOtp(env, parsed.data.identifier, parsed.data.code);
      return reply.send({ ok: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  app.post('/api/v1/auth/login/password', async (req, reply) => {
    const parsed = loginPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const data = await loginWithPassword(
        env,
        parsed.data.identifier,
        parsed.data.password,
      );
      return reply.send({ ok: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      return reply.status(401).send({ ok: false, error: { message } });
    }
  });

  app.post('/api/v1/auth/signup/availability', async (req, reply) => {
    const parsed = signupAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const data = await checkSignupAvailability({
        username: parsed.data.username,
        email: parsed.data.email,
      });
      return reply.send({ ok: true, data });
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({ ok: false, error: { message: 'Could not check availability' } });
    }
  });

  app.post('/api/v1/auth/otp/request', async (req, reply) => {
    const parsed = otpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      await requestOtp(env, parsed.data.email);
      return reply.send({ ok: true, data: { sent: true } });
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({ ok: false, error: { message: 'Failed to send code' } });
    }
  });

  app.post('/api/v1/auth/otp/verify', async (req, reply) => {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const tokens = await verifyOtp(env, parsed.data.email, parsed.data.code);
      return reply.send({ ok: true, data: tokens });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  app.post('/api/v1/auth/signup/request-otp', async (req, reply) => {
    const parsed = signupRequestOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const { age, ...rest } = parsed.data;
      await requestSignupOtp(env, {
        displayName: rest.displayName,
        username: rest.username,
        email: rest.email,
        password: rest.password,
        age: age ?? undefined,
      });
      return reply.send({ ok: true, data: { sent: true } });
    } catch (err) {
      app.log.error(err);
      const message = err instanceof Error ? err.message : 'Failed to send code';
      const clientError =
        message.includes('already') ||
        message.includes('Username') ||
        message.includes('Email is') ||
        message.includes('Username must');
      if (clientError) {
        return reply.status(400).send({ ok: false, error: { message } });
      }
      return reply.status(500).send({ ok: false, error: { message: 'Failed to send code' } });
    }
  });

  app.post('/api/v1/auth/signup/verify', async (req, reply) => {
    const parsed = signupVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const tokens = await verifySignupOtp(env, parsed.data.email, parsed.data.code);
      return reply.send({ ok: true, data: tokens });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  app.post('/api/v1/auth/google', async (req, reply) => {
    const parsed = googleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const tokens = await loginWithGoogle(env, parsed.data.idToken);
      return reply.send({ ok: true, data: tokens });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google login failed';
      return reply.status(401).send({ ok: false, error: { message } });
    }
  });

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }
    try {
      const tokens = await refreshTokens(env, parsed.data.refreshToken);
      return reply.send({ ok: true, data: tokens });
    } catch {
      return reply.status(401).send({ ok: false, error: { message: 'Invalid refresh token' } });
    }
  });
}
