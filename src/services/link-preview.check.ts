/**
 * ponytail: runnable check for OG text cleaners / extractors.
 * Run: npx tsx src/services/link-preview.check.ts
 */
import assert from 'node:assert/strict';

import {
  bookMyShowMobileBannerUrl,
  cleanMetaText,
  cleanTicketTitle,
  extractDescription,
  extractTitle,
  isJunkPreviewImage,
  pickBestImageUrl,
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
assert.equal(
  isJunkPreviewImage('https://assets-in.bmscdn.com/nmcms/synopsis/share_v2.png'),
  true,
);
assert.equal(
  pickBestImageUrl([
    'https://assets-in.bmscdn.com/nmcms/synopsis/share_v2.png',
    'https://assets-in.bmscdn.com/nmcms/events/banner/mobile/poster.jpg',
  ]),
  'https://assets-in.bmscdn.com/nmcms/events/banner/mobile/poster.jpg',
);
assert.equal(
  cleanTicketTitle(
    'Threeory Band Live at Akan Bollywood Night Special music-shows Event Tickets Hyderabad - BookMyShow',
  ),
  'Threeory Band Live at Akan Bollywood Night Special',
);
assert.equal(
  bookMyShowMobileBannerUrl(
    new URL(
      'https://in.bookmyshow.com/events/threeory-band-live-at-akan-july-19/ET00454054',
    ),
  ),
  'https://in.bmscdn.com/Events/Mobile/ET00454054.jpg',
);
assert.equal(
  bookMyShowMobileBannerUrl(new URL('https://example.com/events/ET00454054')),
  null,
);

console.log('link-preview.check: ok');
