import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Express } from 'express';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { LocalStorage } from './local-storage.js';
const settings = {
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY ?? '', secretAccessKey: env.S3_SECRET_KEY ?? '' },
};
const local =
  env.STORAGE_DRIVER === 'local'
    ? new LocalStorage({
        directory: env.UPLOAD_DIR,
        publicUrl: env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`,
        signingKey: env.IDENTITY_HASH_KEY,
      })
    : undefined;
const s3 = local ? undefined : new S3Client({ ...settings, endpoint: env.S3_ENDPOINT });
const signingStorage = local
  ? undefined
  : new S3Client({ ...settings, endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT });
export const storage = {
  destroy() {
    s3?.destroy();
    signingStorage?.destroy();
  },
};
export function storageRoutes(app: Express) {
  local?.routes(app);
}
export async function checkStorage() {
  if (local) return local.check();
  await s3!.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
}
export async function ensureStorage() {
  if (local) return local.ensure();
  try {
    await checkStorage();
  } catch (error) {
    if (env.NODE_ENV === 'production') throw error;
    const code = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (code !== 404) throw error;
    await s3!.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  }
}
export async function putObject(key: string, body: Buffer, mime: string) {
  if (local) return local.put(key, body);
  await s3!.send(
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: mime }),
  );
}
// Server-side document generation reads trusted storage keys, never arbitrary image URLs.
export async function readObject(key: string, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
  if (local) return local.read(key, maxBytes);
  const result = await s3!.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
    abortSignal: AbortSignal.timeout(15000),
  });
  if (!(result.Body instanceof Readable) || (result.ContentLength ?? 0) > maxBytes) {
    if (result.Body instanceof Readable) result.Body.destroy();
    throw new Error('Stored image is missing or exceeds the size limit');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of result.Body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      result.Body.destroy();
      throw new Error('Stored image exceeds the size limit');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function signedDownload(key: string, name?: string, inline = false) {
  if (local) return local.signedDownload(key, name, inline);
  return getSignedUrl(
    signingStorage!,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition:
        (inline ? 'inline' : 'attachment') +
        (name ? `; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}` : ''),
    }),
    { expiresIn: 120 },
  );
}
