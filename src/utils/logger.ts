import { Writable } from 'node:stream';

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

export function createAppLogger(env: Env): pino.Logger | pino.LoggerOptions {
  if (env.NODE_ENV === 'development') {
    return {
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
    };
  }

  initErrorLog(env.LOG_DIR);
  startErrorLogRetention(env.LOG_DIR);

  return pino(
    { level: 'info' },
    pino.multistream([
      { level: 'info', stream: process.stdout },
      { level: 'error', stream: errorFileStream(env.LOG_DIR) },
    ]),
  );
}
