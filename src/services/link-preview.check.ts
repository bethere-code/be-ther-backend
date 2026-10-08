/**
 * ponytail: runnable check for OG text cleaners / extractors.
 * Run: npx tsx src/services/link-preview.check.ts
 */
import assert from 'node:assert/strict';

import {
  cleanMetaText,
  extractDescription,
  extractTitle,
} from './link-preview.service.js';

const sample = `
<head>
  <meta property="og:title" content="Threeory Band Live at Akan" />
  <meta property="og:description" content="Book online tickets for Threeory Band Live at Akan in Hyderabad" />
  <meta property="og:image" content="" />
  <meta property="og:image" content="https://cdn.example.com/poster.jpg" />
  <title>Fallback Title</title>
</head>
`;

assert.equal(extractTitle(sample), 'Threeory Band Live at Akan');
assert.equal(
  extractDescription(sample),
  'Book online tickets for Threeory Band Live at Akan in Hyderabad',
);
assert.equal(cleanMetaText('  a   b  ', 10), 'a b');
assert.ok((cleanMetaText('x'.repeat(250), 200) ?? '').endsWith('…'));
assert.equal(extractTitle('<title>Only Title</title>'), 'Only Title');
assert.equal(extractDescription('<html></html>'), null);

console.log('link-preview.check: ok');
