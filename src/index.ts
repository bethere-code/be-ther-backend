import 'dotenv/config';

import mongoose from 'mongoose';

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { initFirebaseAdmin } from './services/fcm.service.js';
import { logFatalError } from './utils/error-log.js';
import './models/user.model.js';
import './models/otp-challenge.model.js';
import './models/post.model.js';
import './models/like.model.js';
import './models/comment.model.js';
import './models/comment-like.model.js';
import './models/bookmark.model.js';
import './models/calendar.model.js';
import './models/follow.model.js';
import './models/notification.model.js';
import './models/explore-event.model.js';
import './models/explore-bookmark.model.js';
import './models/profile-calendar-hidden.model.js';
import './models/post-report.model.js';
import './models/user-report.model.js';
import './models/block.model.js';
import './models/post-view.model.js';
import './models/analytics-event.model.js';

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

  initFirebaseAdmin(env);

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

  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'Uncaught exception');
    void close();
  });
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'Unhandled rejection');
    void close();
  });

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Listening on http://${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  try {
    const env = loadEnv();
    if (env.NODE_ENV === 'production') {
      logFatalError(env.LOG_DIR, err);
    }
  } catch {
    // Env not loadable — stderr is all we have.
  }
  process.exit(1);
});
