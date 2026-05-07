import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Env } from '../config/env.js';
import { verifyAccessToken } from '../lib/jwt.js';

export async function registerAuthPlugin(app: FastifyInstance, env: Env): Promise<void> {
  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        await reply.status(401).send({ ok: false, error: { message: 'Missing bearer token' } });
        return;
      }
      const token = header.slice('Bearer '.length).trim();
      try {
        const payload = verifyAccessToken(env, token);
        request.userId = payload.sub;
      } catch {
        await reply.status(401).send({ ok: false, error: { message: 'Invalid token' } });
      }
    },
  );
}
