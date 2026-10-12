import type { Express } from 'express';
import { z } from 'zod';
import {
  endpoint,
  id,
  uuid,
  password,
  paginationQuery,
  pagination,
  paged,
} from '../../common/http.js';
import { db, transaction } from '../../database/client.js';
import { found, requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { customerUpdate } from '../../common/notifications.js';
import { authenticate } from '../auth/service.js';
import { imageUpload, uploadImage } from '../images/upload.js';
import { signedDownload } from '../../integrations/storage.js';
import { ownedBookings, visibleDocuments } from './access.js';
import { customerStatement } from './statement.js';
import { inviteCustomer, acceptInvitation, revokeCustomer } from './invitations.js';
import { setCustomerProfilePhoto } from './profile-photo.js';
import {
  dashboard,
  bookingSelect,
  documentSelect,
  projectSelect,
  ownBooking,
  financialPosition,
  projectDay,
  installmentAmounts,
} from './service.js';

const portal = { audience: 'customer' as const };
const listQuery = paginationQuery.extend({ bookingId: uuid.optional() });
const adminRoot = '/projects/:projectId/customers/:id/portal';
export function portalRoutes(app: Express) {
  app.post(
    '/api/v1/portal/profile/photo',
    async (req, _res, next) => {
      const actor = await authenticate(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      requireState(
        actor.accountType === 'CUSTOMER',
        'CUSTOMER_ACCOUNT_REQUIRED',
        'Sign in with your customer account.',
        403,
      );
      next();
    },
    imageUpload,
  );
  endpoint(
    app,
    'post',
    '/portal/profile/photo',
    {
      ...portal,
      summary: 'Update only your own profile photo; JPEG, PNG or WebP up to 5 MiB',
      multipart: true,
      body: z.object({}).strict(),
      status: 201,
      response: z.object({ id: uuid, name: z.string(), mime: z.string(), size: z.number() }),
    },
    async (ctx, _body, _query, req) => {
      const image = await uploadImage(ctx.actor.id, req.file, 'USER');
      await transaction(async (tx) => {
        await setCustomerProfilePhoto(tx, ctx.actor.id, image.id);
        await audit(tx, ctx, 'customer.profile_photo_updated', ctx.actor.id, { photoId: image.id });
      });
      return { id: image.id, name: image.name, mime: image.mime, size: image.size };
    },
  );
  endpoint(
    app,
    'get',
    '/portal/account',
    {
      ...portal,
      summary:
        'Your account identity and profile photo, falling back to your linked customer photo',
      response: z.object({
        id: uuid,
        name: z.string(),
        email: z.string(),
        photoId: uuid.nullable(),
      }),
    },
    async (ctx) => {
      const user = found(
        await db.user.findUnique({
          where: { id: ctx.actor.id },
          select: { id: true, name: true, email: true, photoId: true },
        }),
      );
      const linked = !user.photoId
        ? await db.customer.findFirst({
            where: { portalUserId: ctx.actor.id, photoId: { not: null } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { photoId: true },
          })
        : null;
      return { ...user, photoId: user.photoId ?? linked?.photoId ?? null };
    },
  );
  endpoint(
    app,
    'get',
    '/portal/bookings/:id/statement/download',
    { ...portal, summary: 'Download a scoped PDF statement of your booking and own payments' },
    async (ctx, _b, _q, req) => customerStatement(ctx, id(req)),
  );
  endpoint(
    app,
    'post',
    '/portal/activate',
    {
      public: true,
      summary:
        'Accept a one-time customer invitation; existing customers must enter their current password',
      body: z.object({ token: z.string().min(32).max(200), password }).strict(),
    },
    async (_ctx, body) => acceptInvitation(body.token, body.password),
  );
  endpoint(
    app,
    'get',
    adminRoot,
    {
      permission: 'customers.portal.manage',
      summary: 'View customer portal invitation and access status',
    },
    async (ctx, _b, _q, req) => {
      const customer = found(
        await db.customer.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          select: {
            email: true,
            portalUser: { select: { email: true, active: true } },
            portalInvitations: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { expiresAt: true, usedAt: true, revokedAt: true },
            },
          },
        }),
      );
      const invitation = customer.portalInvitations[0];
      return {
        email: customer.portalUser?.email ?? customer.email,
        status: customer.portalUser
          ? customer.portalUser.active
            ? 'ACTIVE'
            : 'DISABLED'
          : invitation &&
              !invitation.usedAt &&
              !invitation.revokedAt &&
              invitation.expiresAt > new Date()
            ? 'PENDING'
            : 'NOT_ACTIVE',
        expiresAt: invitation?.expiresAt ?? null,
      };
    },
  );
  endpoint(
    app,
    'post',
    adminRoot + '/invite',
    {
      permission: 'customers.portal.manage',
      summary: 'Email a 48-hour customer portal invitation',
    },
    async (ctx, _b, _q, req) => inviteCustomer(ctx, id(req)),
  );
  endpoint(
    app,
    'delete',
    adminRoot,
    {
      permission: 'customers.portal.manage',
      summary: 'Revoke customer portal access and pending invitations',
    },
    async (ctx, _b, _q, req) => revokeCustomer(ctx, id(req)),
  );

  endpoint(
    app,
    'get',
    '/portal/profile',
    { ...portal, summary: 'Your linked customer profiles', query: paginationQuery },
    async (ctx, _b, q) => {
      const where = { portalUserId: ctx.actor.id };
      const [items, total] = await Promise.all([
        db.customer.findMany({
          where,
          ...pagination(q),
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            reference: true,
            name: true,
            phone: true,
            email: true,
            address: true,
            project: { select: projectSelect },
          },
        }),
        db.customer.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    '/portal/dashboard',
    {
      ...portal,
      summary: 'Your confirmed-booking balances by project and next unpaid installments',
    },
    async (ctx) => dashboard(ctx.actor.id),
  );
  endpoint(
    app,
    'get',
    '/portal/bookings',
    { ...portal, summary: 'List only bookings you own', query: paginationQuery },
    async (ctx, _b, q) => {
      const where = ownedBookings(ctx.actor.id);
      const [items, total] = await Promise.all([
        db.booking.findMany({
          where,
          select: bookingSelect,
          ...pagination(q),
          orderBy: { createdAt: 'desc' },
        }),
        db.booking.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    '/portal/bookings/:id',
    { ...portal, summary: 'Your booking detail and exact payment position' },
    async (ctx, _b, _q, req) => {
      const booking = await ownBooking(ctx.actor.id, id(req));
      const position = await financialPosition(
        { AND: [{ id: booking.id }, ownedBookings(ctx.actor.id)] },
        projectDay(booking.unit.project.timezone),
      );
      return { ...booking, position };
    },
  );
  endpoint(
    app,
    'get',
    '/portal/installments',
    {
      ...portal,
      summary: 'Your active-booking installments and allocated balances',
      query: listQuery,
    },
    async (ctx, _b, q) => {
      const where = {
        superseded: false,
        booking: {
          AND: [ownedBookings(ctx.actor.id), { id: q.bookingId, status: 'CONFIRMED' as const }],
        },
      };
      const [items, total] = await Promise.all([
        db.installment.findMany({
          where,
          ...pagination(q),
          orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            label: true,
            dueDate: true,
            amount: true,
            booking: { select: bookingSelect },
            allocations: { where: { reversedAt: null }, select: { amount: true } },
          },
        }),
        db.installment.count({ where }),
      ]);
      return paged(items.map(installmentAmounts), total, q);
    },
  );
  endpoint(
    app,
    'get',
    '/portal/payments',
    { ...portal, summary: 'Your own payment receipts on accessible bookings', query: listQuery },
    async (ctx, _b, q) => {
      const where = {
        payer: { portalUserId: ctx.actor.id },
        booking: { AND: [ownedBookings(ctx.actor.id), { id: q.bookingId }] },
      };
      const [items, total] = await Promise.all([
        db.payment.findMany({
          where,
          ...pagination(q),
          orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            amount: true,
            method: true,
            paidAt: true,
            status: true,
            booking: { select: bookingSelect },
            receipt: { select: { reference: true, createdAt: true, reversedAt: true } },
          },
        }),
        db.payment.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    '/portal/documents',
    { ...portal, summary: 'Documents explicitly shared with you', query: listQuery },
    async (ctx, _b, q) => {
      const where = { AND: [visibleDocuments(ctx.actor.id), { bookingId: q.bookingId }] };
      const [items, total] = await Promise.all([
        db.document.findMany({
          where,
          select: documentSelect,
          ...pagination(q),
          orderBy: { createdAt: 'desc' },
        }),
        db.document.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    '/portal/documents/:id/download',
    { ...portal, summary: 'Download your shared document after a fresh access check' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const doc = found(
          await tx.document.findFirst({
            where: { AND: [{ id: id(req) }, visibleDocuments(ctx.actor.id)] },
            select: { id: true, key: true, projectId: true },
          }),
        );
        await audit(
          tx,
          { ...ctx, projectId: doc.projectId },
          'customer.document_downloaded',
          doc.id,
        );
        return { url: await signedDownload(doc.key), expiresIn: 120 };
      }),
  );
  endpoint(
    app,
    'patch',
    '/projects/:projectId/documents/:id/portal-visibility',
    {
      permission: 'documents.manage',
      summary: 'Explicitly share or withdraw a document from the customer portal',
      body: z.object({ portalVisible: z.boolean() }).strict(),
    },
    async (ctx, body, _q, req) =>
      transaction(async (tx) => {
        const doc = found(
          await tx.document.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        requireState(
          doc.customerId || doc.bookingId,
          'DOCUMENT_CUSTOMER_REQUIRED',
          'Link a customer or booking before sharing a document.',
          422,
        );
        if (doc.customerId)
          requireState(
            ctx.actor.permissions.has('customers.view_sensitive'),
            'FORBIDDEN',
            'Sensitive customer document permission is required.',
            403,
          );
        await tx.document.update({ where: { id: doc.id }, data: body });
        await audit(tx, ctx, 'document.portal_visibility_changed', doc.id, body);
        if (body.portalVisible && !doc.portalVisible) {
          const customers = await tx.customer.findMany({
            where: {
              projectId: ctx.projectId,
              portalUser: { active: true, accountType: 'CUSTOMER' },
              ...(doc.customerId
                ? { id: doc.customerId }
                : {
                    OR: [
                      { bookings: { some: { id: doc.bookingId! } } },
                      { owners: { some: { bookingId: doc.bookingId!, validTo: null } } },
                    ],
                  }),
            },
          });
          for (const customer of customers) {
            if (
              await tx.document.findFirst({
                where: { id: doc.id, AND: [visibleDocuments(customer.portalUserId!)] },
              })
            )
              await customerUpdate(tx, customer.id, 'New document available');
          }
        }
        return { updated: true };
      }),
  );
  endpoint(
    app,
    'get',
    '/portal/requests',
    {
      ...portal,
      summary: 'Your booking workflow statuses without internal approval notes',
      query: listQuery.extend({
        kind: z.enum(['ndcs', 'transfers', 'refunds', 'possessions']).default('ndcs'),
      }),
    },
    async (ctx, _b, q) => {
      const booking = { AND: [ownedBookings(ctx.actor.id), { id: q.bookingId }] };
      const paginationOptions = { ...pagination(q), orderBy: { id: 'desc' as const } };
      if (q.kind === 'ndcs') {
        const where = { booking };
        const [items, total] = await Promise.all([
          db.ndc.findMany({
            where,
            ...paginationOptions,
            select: {
              id: true,
              reference: true,
              status: true,
              issuedAt: true,
              expiresAt: true,
              booking: { select: bookingSelect },
            },
          }),
          db.ndc.count({ where }),
        ]);
        return paged(items, total, q);
      }
      if (q.kind === 'transfers') {
        const where = { booking };
        const [items, total] = await Promise.all([
          db.transfer.findMany({
            where,
            ...paginationOptions,
            select: {
              id: true,
              reference: true,
              status: true,
              charges: true,
              completedAt: true,
              booking: { select: bookingSelect },
            },
          }),
          db.transfer.count({ where }),
        ]);
        return paged(items, total, q);
      }
      if (q.kind === 'refunds') {
        const where = { cancellation: { booking } };
        const [rows, total] = await Promise.all([
          db.refund.findMany({
            where,
            ...paginationOptions,
            select: {
              id: true,
              amount: true,
              status: true,
              paidAt: true,
              cancellation: { select: { booking: { select: bookingSelect } } },
            },
          }),
          db.refund.count({ where }),
        ]);
        return paged(
          rows.map(({ cancellation, ...r }) => ({ ...r, booking: cancellation.booking })),
          total,
          q,
        );
      }
      const where = { booking };
      const [items, total] = await Promise.all([
        db.possession.findMany({
          where,
          ...paginationOptions,
          select: {
            id: true,
            status: true,
            inspectionAt: true,
            handoverAt: true,
            booking: { select: bookingSelect },
          },
        }),
        db.possession.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    '/portal/notifications',
    { ...portal, summary: 'Your customer account notifications', query: paginationQuery },
    async (ctx, _b, q) => {
      const where = { customer: { portalUserId: ctx.actor.id }, channel: 'IN_APP' };
      const [items, total] = await Promise.all([
        db.notification.findMany({
          where,
          ...pagination(q),
          orderBy: { createdAt: 'desc' },
          select: { id: true, title: true, body: true, createdAt: true, readAt: true },
        }),
        db.notification.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    '/portal/notifications/:id/read',
    { ...portal, summary: 'Mark your customer notification read' },
    async (ctx, _b, _q, req) => {
      const result = await db.notification.updateMany({
        where: { id: id(req), customer: { portalUserId: ctx.actor.id }, channel: 'IN_APP' },
        data: { readAt: new Date() },
      });
      requireState(result.count > 0, 'NOT_FOUND', 'Notification not found.', 404);
      return { read: true };
    },
  );
}
