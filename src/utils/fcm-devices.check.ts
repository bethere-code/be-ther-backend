/**
 * ponytail: O(n) device list — upgrade if FCM_DEVICES_MAX grows past dozens.
 */
import {
  BROADCAST_TOPIC,
  cityTopicLabel,
  cityTopicSlug,
  collectUserTokens,
  isCityTopic,
  removeFcmDevice,
  upsertFcmDevice,
} from '../utils/fcm-devices.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(cityTopicSlug('Hyderabad') === 'city_hyderabad', 'city slug');
assert(cityTopicSlug('  ') === null, 'empty city');
assert(isCityTopic('city_hyderabad'), 'is city topic');
assert(!isCityTopic('broadcast'), 'broadcast is not a city topic');
assert(cityTopicLabel('city_hyderabad') === 'Hyderabad', 'city label');
assert(cityTopicLabel('city_new_york') === 'New York', 'multi-word city label');
assert(BROADCAST_TOPIC === 'broadcast', 'broadcast topic');

let devices = upsertFcmDevice([], 'tok_a', 'android');
assert(devices.length === 1 && String(devices[0]?.token) === 'tok_a', 'upsert empty');
devices = upsertFcmDevice(devices, 'tok_b', 'ios');
assert(devices.length === 2 && String(devices[0]?.token) === 'tok_b', 'upsert prepend');
devices = upsertFcmDevice(devices, 'tok_a', 'android');
assert(devices.length === 2 && String(devices[0]?.token) === 'tok_a', 'upsert move front');
devices = removeFcmDevice(devices, 'tok_b');
assert(devices.length === 1 && String(devices[0]?.token) === 'tok_a', 'remove');

const tokens = collectUserTokens({
  fcmToken: 'legacy',
  fcmDevices: [{ token: 'tok_a' }],
});
assert(tokens.includes('tok_a') && tokens.includes('legacy'), 'collect');

console.log('fcm-devices.check: ok');
