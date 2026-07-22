import type { FastifyInstance } from 'fastify';

import type { Env } from '../../config/env.js';
import { registerAuthPlugin } from '../../plugins/auth-plugin.js';
import { registerAuthV1Routes } from './auth.routes.js';
import { registerExploreV1Routes } from './explore.routes.js';
import { registerMediaV1Routes } from './media.routes.js';
import { registerNotificationsV1Routes } from './notifications.routes.js';
import { registerPlacesV1Routes } from './places.routes.js';
import { registerPostsV1Routes } from './posts.routes.js';
import { registerUsersV1Routes } from './users.routes.js';

export async function registerV1Api(app: FastifyInstance, env: Env): Promise<void> {
  await registerAuthPlugin(app, env);
  await registerAuthV1Routes(app, env);
  await registerMediaV1Routes(app, env);
  await registerPlacesV1Routes(app, env);
  await registerPostsV1Routes(app);
  await registerUsersV1Routes(app);
  await registerExploreV1Routes(app);
  await registerNotificationsV1Routes(app);
}
