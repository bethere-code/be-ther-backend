import assert from 'node:assert/strict';

import { postsListFilterFromSets } from '../utils/post-visibility.js';

const me = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const priv = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const followed = 'cccccccccccccccccccccccc';

const hidden = postsListFilterFromSets(me, [], [priv]);
assert.ok(JSON.stringify(hidden).includes('$nin'));

const shown = postsListFilterFromSets(me, [priv], [priv]);
assert.ok(!JSON.stringify(shown).includes('$nin'));

const ownOnly = postsListFilterFromSets(me, [followed], [priv]);
assert.ok(JSON.stringify(ownOnly).includes('$nin'));

const stillHidden = postsListFilterFromSets(me, [priv], [], [priv]);
assert.ok(JSON.stringify(stillHidden).includes('$nin'));

console.log('post-visibility.check.ts ok');
