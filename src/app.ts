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

  if (env.NODE_ENV === 'development') {
    app.addHook('onRequest', async (req) => {
      req.log.info(`-> ${req.method} ${req.url}`);
    });
    app.addHook('onResponse', async (req, reply) => {
      req.log.info(`<-${reply.statusCode} ${req.method} ${req.url} (${reply.elapsedTime.toFixed(1)}ms)`);
    });
  }

  app.addHook('onError', async (req, reply, err) => {
    req.log.error(`${reply.statusCode} ${req.method} ${req.url} - ${err.message}`);
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
