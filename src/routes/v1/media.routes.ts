import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Env } from '../../config/env.js';
import { savePublicObject } from '../../lib/storage.js';
import { fetchLinkPreview } from '../../services/link-preview.service.js';

const allowed = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const maxBytes = 8 * 1024 * 1024;

const linkPreviewQuery = z.object({
  url: z.string().min(1).max(2048),
});

export async function registerMediaV1Routes(app: FastifyInstance, env: Env): Promise<void> {
  /**
   * Resolve Open Graph / Twitter preview image for external ticket links
   * (BookMyShow, District, Eventbrite, …). Must run on the server — same
   * reason WhatsApp previews work: phone HTTP clients are often blocked.
   */
  app.get(
    '/api/v1/link-preview',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = linkPreviewQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          ok: false,
          error: { message: 'A valid url query parameter is required' },
        });
      }

      try {
        const preview = await fetchLinkPreview(parsed.data.url);
        return reply.send({ ok: true, data: preview });
      } catch (err) {
        const status =
          typeof err === 'object' &&
          err !== null &&
          'statusCode' in err &&
          typeof (err as { statusCode: unknown }).statusCode === 'number'
            ? (err as { statusCode: number }).statusCode
            : 502;
        const message =
          err instanceof Error ? err.message : 'Could not fetch link preview';
        return reply.status(status).send({ ok: false, error: { message } });
      }
    },
  );

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
