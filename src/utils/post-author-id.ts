import { Types } from 'mongoose';

/** Resolves a post's author id from an ObjectId or populated `{ _id }` document. */
export function resolvePostAuthorId(authorId: unknown): string {
  if (authorId == null) return '';
  if (authorId instanceof Types.ObjectId) return String(authorId);
  if (typeof authorId === 'string') return authorId;
  if (typeof authorId === 'object' && '_id' in authorId) {
    return resolvePostAuthorId((authorId as { _id: unknown })._id);
  }
  return '';
}
