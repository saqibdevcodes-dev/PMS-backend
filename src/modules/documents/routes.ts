import type { Express } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import { db, transaction } from '../../database/client.js';
import {
  endpoint,
  uuid,
  id,
  pageQuery,
  paginationQuery,
  paged,
  pagination,
} from '../../common/http.js';
import { authenticate } from '../auth/service.js';
import { found, requireState } from '../../common/errors.js';
import { env } from '../../config/env.js';
import { audit, outbox, json } from '../../common/operations.js';
import { putObject, signedDownload } from '../../integrations/storage.js';
const root = '/projects/:projectId';
export function documentRoutes(app: Express) {
  // Authenticate and authorize before accepting multipart bytes.
  app.post(
    '/api/v1' + root + '/documents',
    async (req, _res, next) => {
      const actor = await authenticate(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      requireState(
        actor.permissions.has('documents.manage'),
        'FORBIDDEN',
        'Document upload permission is required.',
        403,
      );
      const projectId = uuid.parse(req.params.projectId);
      found(
        await db.userProjectAccess.findUnique({
          where: { userId_projectId: { userId: actor.id, projectId } },
        }),
      );
      next();
    },
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
    }).single('file'),
  );
  endpoint(
    app,
    'post',
    root + '/documents',
    {
      permission: 'documents.manage',
      summary: 'Upload validated PDF, JPEG or PNG to private storage; 10 MiB maximum',
      multipart: true,
      body: z.object({ customerId: uuid.optional(), bookingId: uuid.optional() }).strict(),
      status: 201,
    },
    async (ctx, b, _q, req) => {
      const file = found(req.file);
      const detected = await fileTypeFromBuffer(file.buffer);
      const extension = path.extname(file.originalname).toLowerCase();
      requireState(
        detected &&
          ['application/pdf', 'image/jpeg', 'image/png'].includes(detected.mime) &&
          (
            {
              'application/pdf': ['.pdf'],
              'image/jpeg': ['.jpg', '.jpeg'],
              'image/png': ['.png'],
            } as Record<string, string[]>
          )[detected.mime]!.includes(extension),
        'INVALID_FILE_TYPE',
        'Upload a valid PDF, JPEG or PNG with a matching extension.',
        422,
      );
      if (b.customerId)
        found(
          await db.customer.findFirst({ where: { id: b.customerId, projectId: ctx.projectId } }),
        );
      if (b.bookingId) {
        const booking = found(
          await db.booking.findFirst({
            where: { id: b.bookingId, unit: { projectId: ctx.projectId } },
          }),
        );
        if (b.customerId)
          requireState(
            (await db.bookingOwner.count({
              where: { bookingId: booking.id, customerId: b.customerId },
            })) > 0,
            'DOCUMENT_OWNER_MISMATCH',
            'The customer is not an owner of this booking.',
            422,
          );
      }
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
          'The uploaded file was not cleared by the scanner.',
          422,
        );
      }
      const key = `projects/${ctx.projectId}/documents/${randomUUID()}${extension}`;
      await putObject(key, file.buffer, detected.mime);
      return transaction(async (tx) => {
        const document = await tx.document.create({
          data: {
            ...b,
            projectId: ctx.projectId,
            key,
            name: path.basename(file.originalname).slice(0, 200),
            mime: detected.mime,
            size: file.size,
            sha256: createHash('sha256').update(file.buffer).digest('hex'),
            uploadedBy: ctx.actor.id,
          },
        });
        await audit(tx, ctx, 'document.uploaded', document.id);
        return document;
      });
    },
  );
  endpoint(
    app,
    'get',
    root + '/documents',
    {
      permission: 'documents.read',
      summary: 'List private document metadata',
      query: pageQuery.extend({ customerId: uuid.optional(), bookingId: uuid.optional() }),
    },
    async (ctx, _b, q) => {
      const where = { projectId: ctx.projectId, customerId: q.customerId, bookingId: q.bookingId };
      const [items, total] = await Promise.all([
        db.document.findMany({ where, ...pagination(q), orderBy: { createdAt: q.sort } }),
        db.document.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    root + '/documents/:id/download',
    { permission: 'documents.read', summary: 'Get audited short-lived private document download' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const document = found(
          await tx.document.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        if (document.customerId)
          requireState(
            ctx.actor.permissions.has('customers.view_sensitive'),
            'FORBIDDEN',
            'Sensitive customer document permission is required.',
            403,
          );
        await audit(tx, ctx, 'document.downloaded', document.id);
        return { url: await signedDownload(document.key), expiresIn: 120 };
      }),
  );
  endpoint(
    app,
    'post',
    root + '/document-templates',
    {
      permission: 'documents.manage',
      summary: 'Create plain-text PDF template; allowed variables use {{name}} syntax',
      body: z
        .object({ name: z.string().min(2).max(100), body: z.string().min(10).max(20000) })
        .strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const latest = await tx.documentTemplate.findFirst({
          where: { projectId: ctx.projectId, name: b.name },
          orderBy: { version: 'desc' },
        });
        return tx.documentTemplate.create({
          data: { ...b, projectId: ctx.projectId, version: (latest?.version ?? 0) + 1 },
        });
      }),
  );
  endpoint(
    app,
    'get',
    root + '/document-templates',
    {
      permission: 'documents.read',
      summary: 'List versioned document templates',
      query: paginationQuery.extend({ search: z.string().max(200).optional() }),
    },
    async (ctx, _b, q) => {
      const where = {
        projectId: ctx.projectId,
        ...(q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
      };
      const [items, total] = await Promise.all([
        db.documentTemplate.findMany({
          where,
          orderBy: [{ name: q.sort }, { version: 'desc' }],
          ...pagination(q),
        }),
        db.documentTemplate.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/document-templates/:id/generate',
    {
      permission: 'documents.manage',
      summary: 'Queue a PDF document for an authorized booking',
      body: z.object({ bookingId: uuid }).strict(),
      status: 202,
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        requireState(
          ctx.actor.permissions.has('reports.export'),
          'FORBIDDEN',
          'Export access is required to retrieve generated files.',
          403,
        );
        found(
          await tx.documentTemplate.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        found(
          await tx.booking.findFirst({
            where: { id: b.bookingId, unit: { projectId: ctx.projectId } },
          }),
        );
        const job = await tx.backgroundJob.create({
          data: {
            projectId: ctx.projectId,
            createdBy: ctx.actor.id,
            kind: 'DOCUMENT',
            payload: json({ templateId: id(req), bookingId: b.bookingId }),
          },
        });
        await outbox(tx, 'document', { jobId: job.id });
        return job;
      }),
  );
}
