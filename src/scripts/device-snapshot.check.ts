import assert from 'node:assert/strict';

import { applyAppVersionToLast, applyDeviceSnapshot } from '../utils/device-snapshot.js';

const signup = { platform: 'android', model: 'Pixel 7', os: '14', appVersion: '1.0.0', appBuild: '4', deviceId: 'dev-a' };
const later = { platform: 'android', model: 'Pixel 8', os: '15', appVersion: '1.0.1', appBuild: '5', deviceId: 'dev-b' };

const created = applyDeviceSnapshot({}, signup, true);
assert.equal(created.firstDevice.model, 'Pixel 7');
assert.equal(created.lastDevice.model, 'Pixel 7');

const loggedIn = applyDeviceSnapshot(created, later, false);
assert.equal(loggedIn.firstDevice.model, 'Pixel 7');
assert.equal(loggedIn.firstDevice.appBuild, '4');
assert.equal(loggedIn.lastDevice.model, 'Pixel 8');
assert.equal(loggedIn.lastDevice.appBuild, '5');

const afterStoreUpdate = applyAppVersionToLast(loggedIn.lastDevice, {
  version: '1.0.2',
  build: '6',
  platform: 'android',
});
assert.equal(afterStoreUpdate.model, 'Pixel 8');
assert.equal(afterStoreUpdate.appVersion, '1.0.2');
assert.equal(loggedIn.firstDevice.appVersion, '1.0.0');

console.log('device-snapshot.check.ts ok');
