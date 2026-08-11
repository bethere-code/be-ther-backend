import type { FastifyInstance } from 'fastify';

import type { Env } from '../config/env.js';
import {
  loadPublicPostForShare,
  renderShareLandingPage,
  renderShareNotFoundPage,
} from '../utils/share-metadata.js';

export async function registerShareRoutes(app: FastifyInstance, env: Env): Promise<void> {
  /** HTML + Open Graph for WhatsApp / iMessage / etc. Must be proxied at site root `/e/`. */
  app.get('/e/:postId', async (req, reply) => {
    const postId = (req.params as { postId: string }).postId;
    const post = await loadPublicPostForShare(postId);

    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      // Let crawlers re-fetch after event edits; WhatsApp still caches aggressively.
      .header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');

    if (!post) {
      return reply.status(404).send(renderShareNotFoundPage());
    }

    return reply.send(renderShareLandingPage(env, post));
  });

  app.get('/.well-known/assetlinks.json', async (_req, reply) => {
    return reply.send([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.bether.app',
          sha256_cert_fingerprints: [
            'REPLACE_WITH_RELEASE_SHA256_FINGERPRINT',
          ],
        },
      },
    ]);
  });

  app.get('/.well-known/apple-app-site-association', async (_req, reply) => {
    reply.header('Content-Type', 'application/json');
    return reply.send({
      applinks: {
        apps: [],
        details: [
          {
            appID: 'TEAMID.com.bether.app',
            paths: ['/e/*'],
          },
        ],
      },
    });
  });
}
