import { Schema, model } from 'mongoose';

/** `blockerId` hid `blockedId`. Unique per pair. */
const blockSchema = new Schema(
  {
    blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    blockedId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true },
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

export const BlockModel = model('Block', blockSchema);
