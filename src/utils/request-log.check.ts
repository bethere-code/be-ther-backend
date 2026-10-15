/** Run: npx tsx src/utils/request-log.check.ts — offline; production logger, no DB needed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {} from '../types/fastify.js';

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bether-log-'));
Object.assign(process.env, {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://127.0.0.1:1/unused',
  JWT_ACCESS_SECRET: 'check-access-secret-123456',
  JWT_REFRESH_SECRET: 'check-refresh-secret-123456',
  GOOGLE_WEB_CLIENT_ID: 'check.apps.googleusercontent.com',
  LOG_DIR: logDir,
});

const { buildApp } = await import('../app.js');
const { loadEnv } = await import('../config/env.js');
const { signAccessToken } = await import('../lib/jwt.js');

const lines: Record<string, unknown>[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => {
  for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
  return true;
}) as typeof process.stdout.write;

const env = loadEnv();
const app = await buildApp(env);
app.get('/boom', { preHandler: [app.authenticate] }, async () => {
  throw new Error('kaboom');
});
await app.ready();

const token = signAccessToken(env, 'user-123');
await app.inject({ method: 'GET', url: '/health' });
await app.inject({ method: 'POST', url: '/api/v1/auth/apple', payload: { identityToken: 5 } });
await app.inject({ method: 'GET', url: '/api/v1/users/me' });
await app.inject({
  method: 'GET',
  url: '/boom',
  headers: { authorization: `Bearer ${token}`, 'user-agent': 'Dart/3.9 (dart:io)', 'x-forwarded-for': '1.2.3.4' },
});
await app.close();
process.stdout.write = write;

const reqLines = lines.filter((l) => typeof l.status === 'number');
assert.ok(!reqLines.some((l) => l.url === '/health'), 'health checks are not logged');

const bad = reqLines.find((l) => l.url === '/api/v1/auth/apple');
assert.equal(bad?.status, 400, JSON.stringify(bad));
assert.equal(bad?.level, 40);
assert.ok(JSON.stringify(bad?.error).includes('identityToken'), 'validation field is in the log');
assert.match(String(bad?.time), /^\d{4}-\d{2}-\d{2}T/, 'ISO timestamp');

const unauth = reqLines.find((l) => l.url === '/api/v1/users/me');
assert.equal(unauth?.status, 401);
assert.deepEqual(unauth?.error, { message: 'Missing bearer token' });

const boom = reqLines.find((l) => l.url === '/boom');
assert.equal(boom?.status, 500);
assert.equal(boom?.level, 50);
assert.equal(boom?.user, 'user-123');
assert.equal(boom?.ip, '1.2.3.4');
assert.equal(boom?.ua, 'Dart/3.9 (dart:io)');
assert.deepEqual(boom?.error, { message: 'kaboom' });
assert.ok(!JSON.stringify(lines).includes(token), 'bearer token never logged');
const stackLine = lines.find((l) => (l.err as { stack?: string } | undefined)?.stack?.includes('kaboom'));
assert.ok(stackLine, 'stack trace logged');
assert.equal(stackLine.reqId, boom.reqId, 'stack and request line share reqId');

const errorFile = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
assert.ok(errorFile.includes('kaboom') && errorFile.includes('"status":500'), '5xx lands in error file');
assert.ok(!errorFile.includes('"status":400'), '4xx stays out of error file');

fs.rmSync(logDir, { recursive: true, force: true });
console.log('request-log check passed');
