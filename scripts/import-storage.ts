import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';
import { LocalStorage } from '../src/integrations/local-storage.js';

if (env.STORAGE_DRIVER !== 'local')
  throw new Error('Set STORAGE_DRIVER=local before importing files');
if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)
  throw new Error(
    'Keep the old S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY for this import',
  );

const source = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
});
const destination = new LocalStorage({
  directory: env.UPLOAD_DIR,
  publicUrl: env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`,
  signingKey: env.IDENTITY_HASH_KEY,
});
let imported = 0;
let continuation: string | undefined;
try {
  await destination.ensure();
  do {
    const page = await source.send(
      new ListObjectsV2Command({ Bucket: env.S3_BUCKET, ContinuationToken: continuation }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key || key.endsWith('/')) continue;
      const response = await source.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      if (!response.Body) throw new Error('Object store returned an empty response body');
      await destination.put(key, Buffer.from(await response.Body.transformToByteArray()));
      imported++;
    }
    continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuation)
      throw new Error('Object store omitted the next page token');
  } while (continuation);
  console.log(
    `Imported ${imported} files into ${destination.directory}. Source objects were retained.`,
  );
} finally {
  source.destroy();
}
