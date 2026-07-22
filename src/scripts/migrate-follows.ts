/**
 * One-time migration: ProfileStar → Follow + denormalized counters.
 *
 * Usage: npx tsx src/scripts/migrate-follows.ts
 *
 * Safe to re-run: skips Follow edges that already exist; recomputes counters from Follow + Posts.
 */
import 'dotenv/config';

import mongoose from 'mongoose';

import { loadEnv } from '../config/env.js';
import { FollowModel } from '../models/follow.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';

async function main(): Promise<void> {
  const env = loadEnv();
  await mongoose.connect(env.MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  const starColl = db.collection('profilestars');
  const stars = await starColl.find({}).toArray();
  console.log(`Found ${stars.length} ProfileStar row(s)`);

  let migrated = 0;
  let skipped = 0;
  for (const star of stars) {
    const followerId = star.fromUserId;
    const followingId = star.toUserId;
    if (!followerId || !followingId) {
      skipped += 1;
      continue;
    }
    try {
      await FollowModel.updateOne(
        { followerId, followingId },
        { $setOnInsert: { followerId, followingId, createdAt: star.createdAt ?? new Date() } },
        { upsert: true },
      );
      migrated += 1;
    } catch {
      skipped += 1;
    }
  }
  console.log(`Follow edges upserted: ${migrated}, skipped: ${skipped}`);

  // Recompute all user counters from source of truth.
  const users = await UserModel.find({}).select('_id').lean();
  console.log(`Recomputing counters for ${users.length} user(s)...`);

  for (const user of users) {
    const id = user._id;
    const [followersCount, followingCount, eventsCount] = await Promise.all([
      FollowModel.countDocuments({ followingId: id }),
      FollowModel.countDocuments({ followerId: id }),
      PostModel.countDocuments({ authorId: id }),
    ]);
    await UserModel.updateOne(
      { _id: id },
      { $set: { followersCount, followingCount, eventsCount } },
    );
  }

  console.log('Done. You can drop the profilestars collection when ready.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
