import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { db } from '../../database/client.js';
import { requireState } from '../../common/errors.js';
import { putObject } from '../../integrations/storage.js';
import { env } from '../../config/env.js';
import type { ImagePurpose } from './service.js';

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
}).single('file');

export async function uploadImage(
  uploadedBy: string,
  input: Express.Multer.File | undefined,
  purpose: ImagePurpose,
  projectId: string | null = null,
) {
  requireState(input, 'IMAGE_REQUIRED', 'Choose a photo to upload.', 422);
  const file = input;
  const detected = await fileTypeFromBuffer(file.buffer);
  const allowed: Record<string, string[]> = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/webp': ['.webp'],
  };
  requireState(
    detected && allowed[detected.mime]?.includes(path.extname(file.originalname).toLowerCase()),
    'INVALID_IMAGE',
    'Choose a valid JPEG, PNG or WebP image up to 5 MiB.',
    422,
  );
  requireState(
    purpose !== 'PROJECT_LOGO' || ['image/png', 'image/jpeg'].includes(detected.mime),
    'INVALID_LOGO',
    'Choose a PNG or JPEG project logo up to 5 MiB for printing and PDF exports.',
    422,
  );
  if (env.MALWARE_SCAN_URL) {
    const scan = await fetch(env.MALWARE_SCAN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${env.PROVIDER_TOKEN ?? ''}`,
      },
      body: new Uint8Array(file.buffer),
      signal: AbortSignal.timeout(30000),
    });
    requireState(
      scan.ok && ((await scan.json()) as { clean?: boolean }).clean === true,
      'FILE_SCAN_REJECTED',
      'The image was not cleared by the scanner.',
      422,
    );
  }
  const key = `images/${randomUUID()}.${detected.ext}`;
  await putObject(key, file.buffer, detected.mime);
  return db.imageAsset.create({
    data: {
      purpose,
      projectId,
      uploadedBy,
      key,
      name: path.basename(file.originalname).slice(0, 200),
      mime: detected.mime,
      size: file.size,
    },
  });
}
