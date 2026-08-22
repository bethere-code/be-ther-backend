import { Writable } from 'node:stream';

import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';

import type { Env } from '../config/env.js';
import { appendErrorLog, initErrorLog, startErrorLogRetention } from './error-log.js';

function errorFileStream(logDir: string): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      const raw = chunk.toString();
      try {
        appendErrorLog(logDir, JSON.parse(raw) as Record<string, unknown>);
      } catch {
        appendErrorLog(logDir, { msg: raw.trim() });
      }
      callback();
    },
  });
}

type AppLoggerOptions =
  | { logger: pino.LoggerOptions }
  | { loggerInstance: FastifyBaseLogger };

export function createAppLoggerOptions(env: Env): AppLoggerOptions {
  if (env.NODE_ENV === 'development') {
    return {
      logger: {
        level: 'debug',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
            singleLine: true,
          },
        },
      },
    };
  }

  initErrorLog(env.LOG_DIR);
  startErrorLogRetention(env.LOG_DIR);

  return {
    loggerInstance: pino(
      { level: 'info' },
      pino.multistream([
        { level: 'info', stream: process.stdout },
        { level: 'error', stream: errorFileStream(env.LOG_DIR) },
      ]),
    ) as FastifyBaseLogger,
  };
}
