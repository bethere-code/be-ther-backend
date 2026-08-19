import assert from 'node:assert/strict';

/** Mirrors Flutter `_pathTemplate` — usernames never stored in analytics paths. */
function pathTemplate(path: string): string {
  const parts = path.split('/');
  if (parts.length >= 3 && parts[1] === 'profile' && parts[2]) {
    parts[2] = ':username';
  }
  return parts.join('/');
}

assert.equal(pathTemplate('/profile/jhansi'), '/profile/:username');
assert.equal(pathTemplate('/profile/jhansi/events'), '/profile/:username/events');
assert.equal(pathTemplate('/feed'), '/feed');
console.log('analytics-path.check.ts ok');
