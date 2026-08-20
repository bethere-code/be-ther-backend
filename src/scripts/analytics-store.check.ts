import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = readFileSync(join(root, 'models/analytics-event.model.ts'), 'utf8');
const routes = readFileSync(join(root, 'routes/v1/analytics.routes.ts'), 'utf8');

assert.match(model, /eventId: \{ type: String, required: true, unique: true \}/);
assert.match(model, /index\(\{ userId: 1, occurredAt: -1 \}\)/);
assert.match(model, /index\(\{ type: 1, occurredAt: -1 \}\)/);
assert.doesNotMatch(model, /userId:.*index: true/);
assert.doesNotMatch(model, /occurredAt:.*index: true/);

assert.match(routes, /MAX_BATCH = 50/);
assert.match(routes, /\$facet/);
assert.match(routes, /insertMany\(docs, \{ ordered: false \}\)/);
assert.match(routes, /'lastDevice\.appVersion'/);
assert.match(routes, /device: deviceSchema/);
assert.match(routes, /applyDeviceSnapshot/);
assert.match(routes, /Range too large/);
assert.match(routes, /firstDevice: user\?\.firstDevice/);

console.log('analytics-store.check.ts ok');
