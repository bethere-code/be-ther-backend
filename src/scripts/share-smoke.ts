import 'dotenv/config';
import mongoose from 'mongoose';

import { loadEnv } from '../config/env.js';
import { PostModel } from '../models/post.model.js';
import { buildShareDescription, renderShareLandingPage } from '../utils/share-metadata.js';

async function main(): Promise<void> {
  const env = loadEnv();
  await mongoose.connect(env.MONGODB_URI);

  const post = await PostModel.findOne({ isPrivate: false })
    .select('location caption imageUrl eventDetails')
    .lean();

  if (!post) {
    console.log('SKIP: no public posts in database');
    await mongoose.disconnect();
    return;
  }

  const html = renderShareLandingPage(env, post as never);
  const checks = ['og:title', 'og:description', 'og:url', 'twitter:card', 'bether://e/'];
  for (const token of checks) {
    if (!html.includes(token)) {
      throw new Error(`Missing ${token} in share HTML`);
    }
  }

  const description = buildShareDescription(post as never);
  if (description.length < 3) {
    throw new Error('Share description too short');
  }

  console.log('OK share landing page', {
    postId: String(post._id),
    title: post.location,
    hasImage: Boolean(post.imageUrl),
    descriptionPreview: description.slice(0, 80),
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
