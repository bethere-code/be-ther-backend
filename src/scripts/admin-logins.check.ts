import assert from 'node:assert/strict';

import { parseAdminLogins } from '../utils/admin-logins.js';

const map = parseAdminLogins('admin@be-ther.com:change_me, ops@be-ther.com:secret');
assert.equal(map.get('admin@be-ther.com'), 'change_me');
assert.equal(map.get('ops@be-ther.com'), 'secret');
assert.equal(parseAdminLogins('').size, 0);
console.log('admin-logins.check.ts ok');
