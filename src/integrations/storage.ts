import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
const settings = {
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
};
export const storage = new S3Client({ ...settings, endpoint: env.S3_ENDPOINT });
const signingStorage = new S3Client({
  ...settings,
  endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
});
export async function ensureStorage() {
  try {
    await storage.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch (error) {
    if (env.NODE_ENV === 'production') throw error;
    const code = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (code !== 404) throw error;
    await storage.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  }
}
export const putObject = (key: string, body: Buffer, mime: string) =>
  storage.send(
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: mime }),
  );
export const signedDownload = (key: string, name?: string, inline = false) =>
  getSignedUrl(
    signingStorage,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition:
        (inline ? 'inline' : 'attachment') +
        (name ? `; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}` : ''),
    }),
    { expiresIn: 120 },
  );
