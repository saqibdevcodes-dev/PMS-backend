import type { Express } from 'express';
import { z } from 'zod';
import { WorkflowStatus } from '@prisma/client';
import { db, transaction, lock } from '../../database/client.js';
import { endpoint, uuid, id, paginationQuery, paged, pagination } from '../../common/http.js';
import { money, positiveMoney } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { scopedBooking, clearedTotal } from '../sales/service.js';
import { decimal } from '../../common/money.js';
import * as workflows from './service.js';
import {
  transferVerification,
  possessionVerification,
  verificationRecord,
  handoverAcknowledgement,
} from './verification.js';
const root = '/projects/:projectId';
const directAction = z.object({}).strict();
const workflowQuery = paginationQuery.extend({
  status: z.enum(WorkflowStatus).optional(),
  bookingId: uuid.optional(),
});
const settlement = z
  .object({ accountId: uuid, paymentReference: z.string().min(3).max(200) })
  .strict();
export function workflowRoutes(app: Express) {
  endpoint(
    app,
    'post',
    root + '/ndcs',
    {
      permission: 'ndc.request',
      summary: 'Request NDC after verifying identity, documents and dues',
      body: z
        .object({ bookingId: uuid, identityVerified: z.boolean(), documentsVerified: z.boolean() })
        .strict(),
    },
    async (ctx, b) => workflows.requestNdc(ctx, b),
  );
  endpoint(
    app,
    'post',
    root + '/ndcs/:id/issue',
    { permission: 'ndc.approve', summary: 'Issue NDC with expiry', body: directAction },
    async (ctx, b, _q, req) => workflows.issueNdc(ctx, id(req)),
  );
  endpoint(
    app,
    'get',
    root + '/ndcs',
    { permission: 'bookings.read', summary: 'List NDC records', query: workflowQuery },
    async (ctx, _b, q) => {
      const where = {
        booking: { unit: { projectId: ctx.projectId } },
        bookingId: q.bookingId,
        status: q.status,
      };
      const [items, total] = await Promise.all([
        db.ndc.findMany({
          where,
          include: { booking: { select: { reference: true } } },
          ...pagination(q),
          orderBy: { id: q.sort },
        }),
        db.ndc.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/transfers',
    {
      permission: 'transfers.request',
      summary: 'Request full ownership transfer',
      body: z
        .object({
          bookingId: uuid,
          buyerId: uuid,
          charges: money,
          verification: transferVerification,
        })
        .strict(),
    },
    async (ctx, b) => workflows.requestTransfer(ctx, b),
  );
  endpoint(
    app,
    'post',
    root + '/transfers/:id/verify-fee',
    {
      permission: 'payments.verify',
      summary: 'Verify and post transfer charge settlement',
      body: settlement,
    },
    async (ctx, b, _q, req) => workflows.transferFee(ctx, id(req), b),
  );
  endpoint(
    app,
    'post',
    root + '/transfers/:id/complete',
    {
      permission: 'transfers.approve',
      summary: 'Atomically transfer ownership and retain previous owners',
      body: directAction,
    },
    async (ctx, b, _q, req) => workflows.completeTransfer(ctx, id(req)),
  );
  endpoint(
    app,
    'post',
    root + '/transfers/:id/withdraw',
    { permission: 'transfers.request', summary: 'Withdraw unpaid pending transfer' },
    async (ctx, _b, _q, req) => workflows.cancelTransfer(ctx, id(req)),
  );
  endpoint(
    app,
    'get',
    root + '/transfers',
    {
      permission: 'bookings.read',
      summary: 'List ownership transfer history',
      query: workflowQuery,
    },
    async (ctx, _b, q) => {
      const where = {
        booking: { unit: { projectId: ctx.projectId } },
        bookingId: q.bookingId,
        status: q.status,
      };
      const [items, total] = await Promise.all([
        db.transfer.findMany({
          where,
          include: { booking: { select: { reference: true } }, buyer: { select: { name: true } } },
          ...pagination(q),
          orderBy: { id: q.sort },
        }),
        db.transfer.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/cancellations',
    {
      permission: 'bookings.cancel',
      summary: 'Request cancellation with explicit deduction and refund calculation',
      body: z
        .object({ bookingId: uuid, deduction: money, reason: z.string().min(3).max(1000) })
        .strict(),
    },
    async (ctx, b) => workflows.requestCancellation(ctx, b),
  );
  endpoint(
    app,
    'post',
    root + '/cancellations/:id/complete',
    {
      permission: 'bookings.cancel',
      summary: 'Execute cancellation and release inventory',
      body: directAction,
    },
    async (ctx, b, _q, req) => workflows.completeCancellation(ctx, id(req)),
  );
  endpoint(
    app,
    'post',
    root + '/cancellations/:id/recalculate',
    {
      permission: 'bookings.cancel',
      summary: 'Recalculate changed collections',
      body: z.object({ deduction: money, reason: z.string().min(3).max(1000) }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const current = found(
          await tx.cancellation.findFirst({
            where: { id: id(req), booking: { unit: { projectId: ctx.projectId } } },
          }),
        );
        await scopedBooking(tx, ctx, current.bookingId);
        await lock(tx, 'Cancellation', current.id);
        requireState(
          current.status === 'PENDING',
          'CANCELLATION_CLOSED',
          'Only pending cancellation amounts can be recalculated.',
        );
        const collected = await clearedTotal(tx, current.bookingId);
        requireState(
          decimal(b.deduction).lte(collected),
          'INVALID_DEDUCTION',
          'Deduction exceeds collections.',
          422,
        );
        await tx.approval.updateMany({
          where: {
            entityId: current.id,
            operation: 'CANCELLATION',
            status: { in: ['PENDING', 'APPROVED'] },
          },
          data: { status: 'REJECTED' },
        });
        const cancellation = await tx.cancellation.update({
          where: { id: current.id },
          data: {
            deduction: b.deduction,
            refundable: collected.minus(b.deduction),
            reason: b.reason,
            requestedBy: ctx.actor.id,
          },
        });
        await audit(tx, ctx, 'cancellation.recalculated', current.id, {
          previousDeduction: current.deduction,
          previousRefundable: current.refundable,
          deduction: cancellation.deduction,
          refundable: cancellation.refundable,
        });
        return { cancellation };
      }),
  );
  endpoint(
    app,
    'get',
    root + '/cancellations',
    {
      permission: 'bookings.read',
      summary: 'List cancellations and staged refunds',
      query: workflowQuery,
    },
    async (ctx, _b, q) => {
      const where = {
        booking: { unit: { projectId: ctx.projectId } },
        bookingId: q.bookingId,
        status: q.status,
      };
      const [items, total] = await Promise.all([
        db.cancellation.findMany({
          where,
          include: { refunds: true, booking: { select: { reference: true } } },
          ...pagination(q),
          orderBy: { id: q.sort },
        }),
        db.cancellation.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/refunds',
    {
      permission: 'refunds.request',
      summary: 'Reserve a partial or complete refund amount',
      body: z.object({ cancellationId: uuid, amount: positiveMoney }).strict(),
    },
    async (ctx, b) => workflows.requestRefund(ctx, b),
  );
  endpoint(
    app,
    'post',
    root + '/refunds/:id/pay',
    {
      permission: 'refunds.approve',
      summary: 'Pay refund and post balanced journal',
      body: settlement,
    },
    async (ctx, b, _q, req) => workflows.payRefund(ctx, id(req), b),
  );
  endpoint(
    app,
    'post',
    root + '/refunds/:id/withdraw',
    {
      permission: 'refunds.request',
      summary: 'Withdraw pending refund and release its reserved balance',
    },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const refund = found(
          await tx.refund.findFirst({
            where: {
              id: id(req),
              cancellation: { booking: { unit: { projectId: ctx.projectId } } },
            },
          }),
        );
        await lock(tx, 'Cancellation', refund.cancellationId);
        await lock(tx, 'Refund', refund.id);
        const current = found(await tx.refund.findUnique({ where: { id: refund.id } }));
        requireState(
          current.status === 'PENDING',
          'REFUND_ALREADY_PAID',
          'Only pending refunds can be withdrawn.',
        );
        await tx.refund.update({ where: { id: refund.id }, data: { status: 'REJECTED' } });
        await tx.approval.updateMany({
          where: {
            entityId: refund.id,
            operation: 'REFUND',
            status: { in: ['PENDING', 'APPROVED'] },
          },
          data: { status: 'REJECTED' },
        });
        await audit(tx, ctx, 'refund.withdrawn', refund.id);
        return { cancelled: true };
      }),
  );
  endpoint(
    app,
    'post',
    root + '/possessions',
    {
      permission: 'possession.manage',
      summary: 'Request possession after clearing dues',
      body: z.object({ bookingId: uuid, verification: possessionVerification }).strict(),
    },
    async (ctx, b) => workflows.requestPossession(ctx, b.bookingId, b.verification),
  );
  endpoint(
    app,
    'get',
    root + '/possessions',
    {
      permission: 'bookings.read',
      summary: 'List possessions, inspections and snags',
      query: workflowQuery,
    },
    async (ctx, _b, q) => {
      const where = {
        booking: { unit: { projectId: ctx.projectId } },
        bookingId: q.bookingId,
        status: q.status,
      };
      const [items, total] = await Promise.all([
        db.possession.findMany({
          where,
          include: { snags: true, booking: { select: { reference: true } } },
          ...pagination(q),
          orderBy: { id: q.sort },
        }),
        db.possession.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/possessions/:id/inspection',
    {
      permission: 'possession.manage',
      summary: 'Record inspection and snag list',
      body: z
        .object({
          notes: z.string().min(3).max(4000),
          snags: z.array(z.string().min(3).max(1000)).max(100),
        })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'Possession', id(req));
        const p = found(
          await tx.possession.findFirst({
            where: { id: id(req), booking: { unit: { projectId: ctx.projectId } } },
          }),
        );
        requireState(
          p.status === 'PENDING',
          'POSSESSION_CLOSED',
          'Only pending possession requests can be inspected.',
        );
        const result = await tx.possession.update({
          where: { id: p.id },
          data: {
            inspectionAt: new Date(),
            inspectionNotes: b.notes,
            snags: { create: b.snags.map((description) => ({ description })) },
          },
          include: { snags: true },
        });
        await audit(tx, ctx, 'possession.inspected', p.id);
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/snags/:id/resolve',
    { permission: 'possession.manage', summary: 'Resolve inspection snag' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const snag = found(
          await tx.snag.findFirst({
            where: { id: id(req), possession: { booking: { unit: { projectId: ctx.projectId } } } },
          }),
        );
        await lock(tx, 'Possession', snag.possessionId);
        const p = found(await tx.possession.findUnique({ where: { id: snag.possessionId } }));
        requireState(p.status === 'PENDING', 'POSSESSION_CLOSED', 'Possession has been closed.');
        const result = await tx.snag.update({
          where: { id: snag.id },
          data: { resolvedAt: new Date() },
        });
        await audit(tx, ctx, 'snag.resolved', snag.id);
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/possessions/:id/handover',
    {
      permission: 'possession.approve',
      summary: 'Complete handover after snag and dues checks',
      body: handoverAcknowledgement,
    },
    async (ctx, b, _q, req) => workflows.handover(ctx, id(req), b),
  );
  for (const kind of ['transfers', 'possessions'] as const) {
    endpoint(
      app,
      'get',
      root + `/${kind}/:id`,
      {
        permission: 'bookings.read',
        summary: 'Get ownership case details',
      },
      async (ctx, _b, _q, req) => {
        const where = { id: id(req), booking: { unit: { projectId: ctx.projectId } } };
        const booking = {
          select: {
            reference: true,
            customer: { select: { name: true } },
            unit: { select: { number: true } },
          },
        };
        return found(
          kind === 'transfers'
            ? await db.transfer.findFirst({
                where,
                include: { booking, buyer: { select: { name: true } } },
              })
            : await db.possession.findFirst({ where, include: { booking, snags: true } }),
        );
      },
    );
    endpoint(
      app,
      'patch',
      root + `/${kind}/:id/verification`,
      {
        permission: kind === 'transfers' ? 'transfers.request' : 'possession.manage',
        summary: 'Review case documents',
        body: z
          .object({
            verification: kind === 'transfers' ? transferVerification : possessionVerification,
          })
          .strict(),
      },
      async (ctx, body, _q, req) =>
        transaction(async (tx) => {
          const where = { id: id(req), booking: { unit: { projectId: ctx.projectId } } };
          const current = found(
            kind === 'transfers'
              ? await tx.transfer.findFirst({ where })
              : await tx.possession.findFirst({ where }),
          );
          const booking = await scopedBooking(tx, ctx, current.bookingId);
          await lock(tx, kind === 'transfers' ? 'Transfer' : 'Possession', current.id);
          const latest = found(
            kind === 'transfers'
              ? await tx.transfer.findUnique({ where: { id: current.id } })
              : await tx.possession.findUnique({ where: { id: current.id } }),
          );
          requireState(
            latest.status === 'PENDING',
            'REQUEST_CLOSED',
            'Only pending requests can be updated.',
          );
          const data = {
            verification: verificationRecord(
              body.verification,
              booking.owners.map((owner) => owner.customerId),
              ctx.actor.id,
            ),
          };
          const result =
            kind === 'transfers'
              ? await tx.transfer.update({ where: { id: current.id }, data })
              : await tx.possession.update({ where: { id: current.id }, data });
          await audit(tx, ctx, `${kind}.documents_reviewed`, current.id, data);
          return result;
        }),
    );
  }
}
