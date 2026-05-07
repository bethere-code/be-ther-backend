import 'dotenv/config';

import mongoose from 'mongoose';

import { loadEnv } from '../config/env.js';
import { ExploreEventModel } from '../models/explore-event.model.js';

const seed = [
  {
    title: 'Tomorrowland Festival',
    location: 'Boom',
    country: 'Belgium',
    type: 'concert' as const,
    image: 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=800&q=80',
    date: 'Jul 18-27, 2026',
    venue: 'De Schorre',
    ticketUrl: 'tomorrowland.com',
    attendees: 842,
    trending: true,
  },
  {
    title: 'Northern Lights Tour',
    location: 'Reykjavik',
    country: 'Iceland',
    type: 'place' as const,
    image: 'https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=800&q=80',
    date: 'Sep 15 - Oct 15, 2026',
    venue: 'Golden Circle',
    ticketUrl: 'guidetoiceland.is',
    attendees: 523,
    trending: true,
  },
  {
    title: 'Coachella Valley Music',
    location: 'Indio',
    country: 'California, USA',
    type: 'concert' as const,
    image: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=80',
    date: 'Apr 10-19, 2026',
    venue: 'Empire Polo Club',
    ticketUrl: 'coachella.com',
    attendees: 1243,
    trending: true,
  },
];

async function main(): Promise<void> {
  const env = loadEnv();
  await mongoose.connect(env.MONGODB_URI);
  await ExploreEventModel.deleteMany({});
  await ExploreEventModel.insertMany(seed);
  console.info('Seeded explore events:', seed.length);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
