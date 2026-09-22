import type { Express } from 'express';
import { z } from 'zod';
import { WorkflowStatus } from '@prisma/client';
import { db, transaction, lock } from '../../database/client.js';
import {
  endpoint,
  uuid,
  id,
  pageQuery,
  paginationQuery,
  paged,
  pagination,
} from '../../common/http.js';
import { money, positiveMoney } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { permissions } from '../../common/permissions.js';
import {
  decide,
  approvalPermissions,
  requestApproval,
  type Operation,
} from '../approvals/service.js';
import { scopedBooking, clearedTotal } from '../sales/service.js';
import { decimal } from '../../common/money.js';
import * as workflows from './service.js';
const root = '/projects/:projectId';
const approved = z.object({ approvalId: uuid }).strict();
const workflowQuery = paginationQuery.extend({
  status: z.enum(WorkflowStatus).optional(),
  bookingId: uuid.optional(),
});
const settlement = z
  .object({ approvalId: uuid, accountId: uuid, paymentReference: z.string().min(3).max(200) })
  .strict();
export function workflowRoutes(app: Express) {
  endpoint(
    app,
    'get',
    root + '/approvals',
    {
      permission: 'approvals.read',
      summary: 'List approval requests with action history',
      query: pageQuery,
    },
    async (ctx, _b, q) => {
      const where = { projectId: ctx.projectId };
      const [items, total] = await Promise.all([
        db.approval.findMany({
          where,
          ...pagination(q),
          include: { actions: true },
          orderBy: { createdAt: q.sort },
        }),
        db.approval.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/approvals/:id/decide',
    {
      summary: 'Act on current approval level; designated permission required',
      body: z
        .object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().min(3).max(1000) })
        .strict(),
    },
    async (ctx, b, _q, req) => decide(ctx, id(req), b.decision, b.comment),
  );
  endpoint(
    app,
    'post',
    root + '/approvals/:id/resubmit',
    { summary: 'Resubmit your rejected approval with its original terms' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const old = found(
          await tx.approval.findFirst({
            where: { id: id(req), projectId: ctx.projectId, requestedBy: ctx.actor.id },
          }),
        );
        requireState(
          old.status === 'REJECTED',
          'APPROVAL_NOT_REJECTED',
          'Only a rejected request can be resubmitted.',
        );
        const operation = old.operation as Operation;
        const requestPermissions: Record<Operation, string> = {
          DISCOUNT: 'discounts.request',
          BOOKING: 'bookings.create',
          PRICE: 'inventory.update',
          RESCHEDULE: 'bookings.create',
          PAYMENT_REVERSAL: 'payments.reverse',
          NDC: 'ndc.request',
          TRANSFER: 'transfers.request',
          CANCELLATION: 'bookings.cancel',
          REFUND: 'refunds.request',
          COMMISSION: 'commissions.approve',
          POSSESSION: 'possession.manage',
          JOURNAL: 'finance.post',
        };
        requireState(
          ctx.actor.permissions.has(requestPermissions[operation]),
          'FORBIDDEN',
          'Request permission is required.',
          403,
        );
        return requestApproval(
          tx,
          ctx,
          operation,
          old.entityId,
          old.amount.toFixed(2),
          old.payload,
        );
      }),
  );
  endpoint(
    app,
    'post',
    root + '/approval-policies',
    {
      permission: 'approvals.manage',
      summary: 'Configure approval thresholds and sequential permission levels',
      body: z
        .object({
          operation: z.enum(
            Object.keys(approvalPermissions) as [
              keyof typeof approvalPermissions,
              ...(keyof typeof approvalPermissions)[],
            ],
          ),
          minimumAmount: money,
          permissions: z.array(z.enum(permissions)).min(1).max(5),
        })
        .strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const result = await tx.approvalPolicy.upsert({
          where: {
            projectId_operation_minimumAmount: {
              projectId: ctx.projectId,
              operation: b.operation,
              minimumAmount: b.minimumAmount,
            },
          },
          create: { ...b, projectId: ctx.projectId },
          update: { permissions: b.permissions },
        });
        await audit(tx, ctx, 'approval.policy_changed', result.id, b);
        return result;
      }),
  );
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
    { permission: 'ndc.approve', summary: 'Issue approved NDC with expiry', body: approved },
    async (ctx, b, _q, req) => workflows.issueNdc(ctx, id(req), b.approvalId),
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
        db.ndc.findMany({ where, ...pagination(q), orderBy: { id: q.sort } }),
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
      body: z.object({ bookingId: uuid, buyerId: uuid, ndcId: uuid, charges: money }).strict(),
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
      body: settlement.omit({ approvalId: true }),
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
      body: approved,
    },
    async (ctx, b, _q, req) => workflows.completeTransfer(ctx, id(req), b.approvalId),
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
        db.transfer.findMany({ where, ...pagination(q), orderBy: { id: q.sort } }),
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
      summary: 'Execute approved cancellation and release inventory',
      body: approved,
    },
    async (ctx, b, _q, req) => workflows.completeCancellation(ctx, id(req), b.approvalId),
  );
  endpoint(
    app,
    'post',
    root + '/cancellations/:id/recalculate',
    {
      permission: 'bookings.cancel',
      summary: 'Recalculate changed collections and request fresh cancellation approval',
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
        const approval = await requestApproval(
          tx,
          ctx,
          'CANCELLATION',
          current.id,
          cancellation.refundable.toFixed(2),
        );
        return { cancellation, approval };
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
          include: { refunds: true },
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
      summary: 'Pay approved refund and post balanced journal',
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
      body: z.object({ bookingId: uuid }).strict(),
    },
    async (ctx, b) => workflows.requestPossession(ctx, b.bookingId),
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
          include: { snags: true },
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
      summary: 'Complete approved handover after snag and dues checks',
      body: approved,
    },
    async (ctx, b, _q, req) => workflows.handover(ctx, id(req), b.approvalId),
  );
  endpoint(
    app,
    'post',
    root + '/commissions/:id/settle',
    {
      permission: 'commissions.approve',
      summary: 'Settle approved dealer commission once',
      body: settlement,
    },
    async (ctx, b, _q, req) => workflows.settleCommission(ctx, id(req), b),
  );
}
