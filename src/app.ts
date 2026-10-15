import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import path from 'path';

import type { Env } from './config/env.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerShareRoutes } from './routes/share.routes.js';
import { registerV1Api } from './routes/v1/index.js';
import { createAppLoggerOptions } from './utils/logger.js';
import { rewriteStrippedApiPrefix } from './utils/rewrite-stripped-api-prefix.js';

export async function buildApp(env: Env) {
  const app = Fastify({
    ...createAppLoggerOptions(env),
    disableRequestLogging: true,
    rewriteUrl: (req) => rewriteStrippedApiPrefix(req.url ?? '/'),
  });

  await app.register(compress, { global: true, threshold: 1024 });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });

  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024 },
  });

  await app.register(staticFiles, {
    root: path.join(process.cwd(), 'uploads'),
    prefix: '/static/',
    decorateReply: false,
  });

  await registerHealthRoutes(app);
  await registerShareRoutes(app, env);
  await registerV1Api(app, env);

  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      try {
        req.errorBody = (JSON.parse(payload) as { error?: unknown }).error;
      } catch {
        req.errorBody = payload.slice(0, 500);
      }
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health') return;
    const status = reply.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    req.log[level](
      {
        method: req.method,
        url: req.url,
        status,
        ms: Math.round(reply.elapsedTime),
        user: req.userId ?? req.adminEmail,
        ip: req.headers['x-forwarded-for'] ?? req.ip,
        ua: req.headers['user-agent'],
        error: req.errorBody,
      },
      `${status} ${req.method} ${req.url}`,
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const err = error as { code?: string; statusCode?: number; message?: string };
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      void reply.status(413).send({
        ok: false,
        error: { message: 'File too large. Maximum size is 8 MB.' },
      });
      return;
    }
    request.log.error(error);
    const status = err.statusCode ?? 500;
    void reply.status(status).send({
      ok: false,
      error: { message: err.message || 'Request failed' },
    });
  });

  return app;
}
