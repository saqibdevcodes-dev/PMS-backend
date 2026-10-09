import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import { endpoint, uuid, id } from '../../common/http.js';
import { db } from '../../database/client.js';
import { authenticate } from '../auth/service.js';
import { found, requireState } from '../../common/errors.js';
import { putObject, signedDownload } from '../../integrations/storage.js';
import { env } from '../../config/env.js';
import { purposes, imageGrants, type ImagePurpose } from './service.js';

export function imageRoutes(app: Express) {
  app.post(
    '/api/v1/images',
    async (req, _res, next) => {
      const actor = await authenticate(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      requireState(
        actor.accountType !== 'CUSTOMER' &&
          Object.values(imageGrants).some((g) => g.write.some((p) => actor.permissions.has(p))),
        'FORBIDDEN',
        'You cannot upload images.',
        403,
      );
      next();
    },
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
    }).single('file'),
  );
  endpoint(
    app,
    'post',
    '/images',
    {
      summary: 'Upload a private record image; JPEG, PNG or WebP up to 5 MiB',
      multipart: true,
      body: z.object({ purpose: z.enum(purposes), projectId: uuid.optional() }).strict(),
      status: 201,
      response: z.object({ id: uuid, name: z.string(), mime: z.string(), size: z.number() }),
    },
    async (ctx, body, _q, req) => {
      const grants = imageGrants[body.purpose];
      requireState(
        grants.write.some((p) => ctx.actor.permissions.has(p)),
        'FORBIDDEN',
        'Image upload permission is required.',
        403,
      );
      const scoped = !['PROJECT', 'USER'].includes(body.purpose);
      requireState(
        !scoped || body.projectId,
        'PROJECT_REQUIRED',
        'Select a project before uploading an image.',
        422,
      );
      if (body.projectId)
        found(
          await db.userProjectAccess.findUnique({
            where: { userId_projectId: { userId: ctx.actor.id, projectId: body.projectId } },
          }),
        );
      const file = found(req.file);
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
      const image = await db.imageAsset.create({
        data: {
          purpose: body.purpose,
          projectId: scoped ? body.projectId : null,
          uploadedBy: ctx.actor.id,
          key,
          name: path.basename(file.originalname).slice(0, 200),
          mime: detected.mime,
          size: file.size,
        },
      });
      return { id: image.id, name: image.name, mime: image.mime, size: image.size };
    },
  );
  endpoint(
    app,
    'get',
    '/images/:id',
    {
      summary: 'Get a short-lived image URL after checking record access',
      response: z.object({ url: z.url(), expiresIn: z.number(), name: z.string() }),
    },
    async (ctx, _b, _q, req) => {
      const image = found(await db.imageAsset.findUnique({ where: { id: id(req) } }));
      const grants = imageGrants[image.purpose as ImagePurpose];
      requireState(
        grants && [...grants.read, ...grants.write].some((p) => ctx.actor.permissions.has(p)),
        'FORBIDDEN',
        'Image access is restricted.',
        403,
      );
      if (image.projectId)
        found(
          await db.userProjectAccess.findUnique({
            where: { userId_projectId: { userId: ctx.actor.id, projectId: image.projectId } },
          }),
        );
      else if (image.purpose === 'PROJECT' && image.uploadedBy !== ctx.actor.id)
        found(
          await db.project.findFirst({
            where: { photoId: image.id, access: { some: { userId: ctx.actor.id } } },
          }),
        );
      else if (image.purpose === 'USER' && image.uploadedBy !== ctx.actor.id)
        found(await db.user.findFirst({ where: { photoId: image.id } }));
      return {
        url: await signedDownload(image.key, image.name, true),
        expiresIn: 120,
        name: image.name,
      };
    },
  );
}
