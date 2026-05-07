import type { FastifyInstance } from 'fastify';

import type { Env } from '../../config/env.js';
import { savePublicObject } from '../../lib/storage.js';

const allowed = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const maxBytes = 8 * 1024 * 1024;

export async function registerMediaV1Routes(app: FastifyInstance, env: Env): Promise<void> {
  app.post(
    '/api/v1/media/upload',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const file = await req.file({ limits: { fileSize: maxBytes } });
      if (!file) {
        return reply.status(400).send({ ok: false, error: { message: 'Missing file field "file"' } });
      }
      const mimetype = file.mimetype;
      if (!allowed.has(mimetype)) {
        return reply.status(400).send({ ok: false, error: { message: 'Unsupported file type' } });
      }
      const buffer = await file.toBuffer();
      if (buffer.length > maxBytes) {
        return reply.status(400).send({ ok: false, error: { message: 'File too large' } });
      }
      const url = await savePublicObject(env, buffer, mimetype);
      return reply.send({ ok: true, data: { url } });
    },
  );
}
