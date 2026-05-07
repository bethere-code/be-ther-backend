import 'dotenv/config';

import mongoose from 'mongoose';

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import './models/user.model.js';
import './models/otp-challenge.model.js';
import './models/post.model.js';
import './models/like.model.js';
import './models/bookmark.model.js';
import './models/profile-star.model.js';
import './models/notification.model.js';
import './models/explore-event.model.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  mongoose.connection.on('connected', () => {
    app.log.info(
      {
        db: mongoose.connection.name,
        host: mongoose.connection.host,
      },
      'MongoDB connected',
    );
  });
  mongoose.connection.on('disconnected', () => {
    app.log.warn('MongoDB disconnected');
  });
  mongoose.connection.on('error', (err) => {
    app.log.error({ err }, 'MongoDB connection error');
  });

  await mongoose.connect(env.MONGODB_URI);

  const close = async () => {
    try {
      await app.close();
      await mongoose.connection.close();
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Listening on http://${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
