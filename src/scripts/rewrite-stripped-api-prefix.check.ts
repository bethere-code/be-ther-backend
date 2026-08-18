import assert from 'node:assert/strict';

import Fastify from 'fastify';

import { rewriteStrippedApiPrefix } from '../utils/rewrite-stripped-api-prefix.js';

assert.equal(
  rewriteStrippedApiPrefix('/v1/auth/signup/availability'),
  '/api/v1/auth/signup/availability',
);
assert.equal(
  rewriteStrippedApiPrefix('/v1/auth/login/password?x=1'),
  '/api/v1/auth/login/password?x=1',
);
assert.equal(rewriteStrippedApiPrefix('/api/v1/auth/login/password'), '/api/v1/auth/login/password');
assert.equal(rewriteStrippedApiPrefix('/health'), '/health');
assert.equal(rewriteStrippedApiPrefix('/e/abc'), '/e/abc');

const app = Fastify({
  rewriteUrl: (req) => rewriteStrippedApiPrefix(req.url ?? '/'),
});
app.post('/api/v1/auth/signup/availability', async () => ({ ok: true }));
app.post('/api/v1/auth/login/password', async () => ({ ok: true }));
await app.ready();

const availability = await app.inject({
  method: 'POST',
  url: '/v1/auth/signup/availability',
  payload: { username: 'testaccount123' },
});
assert.equal(availability.statusCode, 200, availability.body);

const login = await app.inject({
  method: 'POST',
  url: '/v1/auth/login/password',
  payload: { identifier: 'test', password: 'testtest1' },
});
assert.equal(login.statusCode, 200, login.body);

const local = await app.inject({
  method: 'POST',
  url: '/api/v1/auth/login/password',
  payload: { identifier: 'test', password: 'testtest1' },
});
assert.equal(local.statusCode, 200, local.body);

await app.close();
console.log('rewrite-stripped-api-prefix: ok');
