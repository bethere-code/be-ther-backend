import assert from 'node:assert/strict';

import { applyAppVersionToLast, applyDeviceSnapshot } from '../utils/device-snapshot.js';

const signup = {
  platform: 'android',
  model: 'Pixel 7',
  os: '14',
  appVersion: '1.0.0',
  appBuild: '4',
  deviceId: 'dev-a',
  location: { lat: 17.38, lng: 78.48, accuracyM: 20 },
};
const later = {
  platform: 'android',
  model: 'Pixel 8',
  os: '15',
  appVersion: '1.0.1',
  appBuild: '5',
  deviceId: 'dev-b',
};

const created = applyDeviceSnapshot({}, signup, true);
assert.equal(created.firstDevice.model, 'Pixel 7');
assert.equal(created.lastDevice.model, 'Pixel 7');
assert.equal(created.lastDevice.location?.lat, 17.38);

const loggedIn = applyDeviceSnapshot(created, later, false);
assert.equal(loggedIn.firstDevice.model, 'Pixel 7');
assert.equal(loggedIn.firstDevice.appBuild, '4');
assert.equal(loggedIn.lastDevice.model, 'Pixel 8');
assert.equal(loggedIn.lastDevice.appBuild, '5');
// Incoming login without location keeps previous coords.
assert.equal(loggedIn.lastDevice.location?.lat, 17.38);

const afterStoreUpdate = applyAppVersionToLast(loggedIn.lastDevice, {
  version: '1.0.2',
  build: '6',
  platform: 'android',
});
assert.equal(afterStoreUpdate.model, 'Pixel 8');
assert.equal(afterStoreUpdate.appVersion, '1.0.2');
assert.equal(afterStoreUpdate.location?.lng, 78.48);
assert.equal(loggedIn.firstDevice.appVersion, '1.0.0');

console.log('device-snapshot.check.ts ok');
