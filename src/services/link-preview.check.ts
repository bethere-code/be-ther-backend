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
  extractEventDateTime,
  extractTitle,
  extractVenueQuery,
  filterUpcomingDateTime,
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

const bmsUrl = new URL(
  'https://in.bookmyshow.com/events/threeory-band-live-at-akan-july-19/ET00454054',
);
assert.equal(
  extractVenueQuery(
    'Book online tickets happening at Akan: Hyderabad on BookMyShow',
    bmsUrl,
  ),
  'Akan Hyderabad',
);
assert.equal(
  extractVenueQuery(
    'Threeory Band takes the stage at AKAN Hyderabad. Known for their dynamic',
    bmsUrl,
  ),
  'AKAN Hyderabad',
);
assert.equal(
  extractEventDateTime('Sun 11 Oct 2026 calendar.png something')?.date,
  '2026-10-11',
);
assert.equal(
  filterUpcomingDateTime('2020-01-01', '20:00', new Date('2026-10-08T12:00:00Z')),
  null,
);
assert.deepEqual(
  filterUpcomingDateTime('2026-10-11', '18:30', new Date('2026-10-08T12:00:00Z')),
  { date: '2026-10-11', time: '18:30' },
);

console.log('link-preview.check: ok');
