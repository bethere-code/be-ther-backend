import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, writeFile } from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';

import type { Env } from '../config/env.js';

function extFromMime(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  return '';
}

export async function savePublicObject(env: Env, buffer: Buffer, mime: string): Promise<string> {
  const ext = extFromMime(mime);
  const key = `media/${nanoid()}${ext}`;

  if (env.MEDIA_STORAGE === 'r2') {
    const endpoint = env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
    });
    await client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET!,
        Key: key,
        Body: buffer,
        ContentType: mime,
      }),
    );
    const base = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? env.PUBLIC_BASE_URL;
    return `${base}/${key}`;
  }

  const dir = path.join(process.cwd(), 'uploads');
  await mkdir(dir, { recursive: true });
  const filename = `${nanoid()}${ext}`;
  const full = path.join(dir, filename);
  await writeFile(full, buffer);
  const pub = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${pub}/static/${filename}`;
}
