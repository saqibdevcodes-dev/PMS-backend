import type { Express } from 'express';
import { z } from 'zod';
import { endpoint, uuid, id } from '../../common/http.js';
import { db } from '../../database/client.js';
import { authenticate } from '../auth/service.js';
import { found, requireState } from '../../common/errors.js';
import { signedDownload } from '../../integrations/storage.js';
import { imageUpload, uploadImage } from './upload.js';
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
    imageUpload,
  );
  endpoint(
    app,
    'post',
    '/images',
    {
      summary: 'Upload a private record image; JPEG, PNG or WebP up to 5 MiB',
      multipart: true,
      body: z
        .object({
          purpose: z.enum(purposes.filter((p) => p !== 'DEALER')),
          projectId: uuid.optional(),
        })
        .strict(),
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
      const image = await uploadImage(
        ctx.actor.id,
        req.file,
        body.purpose,
        scoped ? body.projectId! : null,
      );
      return { id: image.id, name: image.name, mime: image.mime, size: image.size };
    },
  );
  endpoint(
    app,
    'get',
    '/images/:id',
    {
      audience: 'authenticated',
      summary: 'Get a short-lived image URL after checking record access',
      response: z.object({ url: z.url(), expiresIn: z.number(), name: z.string() }),
    },
    async (ctx, _b, _q, req) => {
      const image = found(await db.imageAsset.findUnique({ where: { id: id(req) } }));
      if (ctx.actor.accountType === 'CUSTOMER') {
        const ownPhoto =
          image.purpose === 'USER'
            ? image.uploadedBy === ctx.actor.id ||
              !!(await db.user.findFirst({ where: { id: ctx.actor.id, photoId: image.id } }))
            : image.purpose === 'CUSTOMER' &&
              !!(await db.customer.findFirst({
                where: { portalUserId: ctx.actor.id, photoId: image.id },
              }));
        found(ownPhoto ? image : null);
        return {
          url: await signedDownload(image.key, image.name, true),
          expiresIn: 120,
          name: image.name,
        };
      }
      // A customer account can share its photo across its linked project records.
      // Staff need customer permissions and access to one of those records.
      const sharedCustomerPhoto =
        ['USER', 'CUSTOMER'].includes(image.purpose) &&
        [...imageGrants.CUSTOMER.read, ...imageGrants.CUSTOMER.write].some((permission) =>
          ctx.actor.permissions.has(permission),
        ) &&
        !!(await db.customer.findFirst({
          where: {
            photoId: image.id,
            project: { access: { some: { userId: ctx.actor.id } } },
          },
        }));
      if (sharedCustomerPhoto)
        return {
          url: await signedDownload(image.key, image.name, true),
          expiresIn: 120,
          name: image.name,
        };
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
            where: {
              OR: [
                { photoId: image.id },
                { photoIds: { has: image.id } },
                { featureImages: { array_contains: [{ imageId: image.id }] } },
              ],
              access: { some: { userId: ctx.actor.id } },
            },
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
