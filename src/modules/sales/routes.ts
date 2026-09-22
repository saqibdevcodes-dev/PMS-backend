import type { Express } from 'express';
import { z } from 'zod';
import { Prisma, PaymentStatus, BookingStatus } from '@prisma/client';
import { db, transaction } from '../../database/client.js';
import {
  endpoint,
  pageQuery,
  paginationQuery,
  pagination,
  paged,
  uuid,
  id,
  idempotencyKey,
} from '../../common/http.js';
import { money, positiveMoney, decimal } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { requestApproval } from '../approvals/service.js';
import { scopedUnit } from '../inventory/service.js';
import * as sales from './service.js';
const root = '/projects/:projectId';
export function salesRoutes(app: Express) {
  endpoint(
    app,
    'post',
    root + '/reservations',
    {
      permission: 'reservations.create',
      summary: 'Reserve available inventory with concurrency protection',
      body: z.object({ unitId: uuid, customerId: uuid }).strict(),
      status: 201,
    },
    async (ctx, b) => sales.reserve(ctx, b),
  );
  endpoint(
    app,
    'get',
    root + '/reservations',
    { permission: 'bookings.read', summary: 'List reservations', query: pageQuery },
    async (ctx, _b, q) => {
      const where: Prisma.ReservationWhereInput = { unit: { projectId: ctx.projectId } };
      const [items, total] = await Promise.all([
        db.reservation.findMany({ where, ...pagination(q), orderBy: { createdAt: q.sort } }),
        db.reservation.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/reservations/:id/cancel',
    {
      permission: 'reservations.cancel',
      summary: 'Cancel active reservation and release inventory',
    },
    async (ctx, _b, _q, req) => sales.cancelReservation(ctx, id(req)),
  );
  endpoint(
    app,
    'post',
    root + '/units/:id/discount-requests',
    {
      permission: 'discounts.request',
      summary: 'Request a specific discount amount',
      body: z.object({ amount: positiveMoney }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const unit = await scopedUnit(tx, ctx, id(req));
        requireState(
          decimal(b.amount).lt(unit.price.plus(unit.charges)),
          'INVALID_DISCOUNT',
          'Discount must be less than gross price.',
          422,
        );
        return requestApproval(tx, ctx, 'DISCOUNT', unit.id, b.amount, b);
      }),
  );
  endpoint(
    app,
    'post',
    root + '/payment-plans',
    {
      permission: 'plans.manage',
      summary: 'Create immutable payment plan version',
      body: z.object({ name: z.string().min(2).max(200), schedule: sales.scheduleSchema }).strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const plan = await tx.paymentPlan.create({
          data: {
            projectId: ctx.projectId,
            name: b.name,
            versions: {
              create: { version: 1, schedule: sales.planData(b.schedule), createdBy: ctx.actor.id },
            },
          },
          include: { versions: true },
        });
        await audit(tx, ctx, 'plan.created', plan.id);
        return plan;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/payment-plans/:id/versions',
    {
      permission: 'plans.manage',
      summary: 'Add new plan version without changing existing bookings',
      body: z.object({ schedule: sales.scheduleSchema }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        found(await tx.paymentPlan.findFirst({ where: { id: id(req), projectId: ctx.projectId } }));
        const latest = found(
          await tx.paymentPlanVersion.findFirst({
            where: { planId: id(req) },
            orderBy: { version: 'desc' },
          }),
        );
        return tx.paymentPlanVersion.create({
          data: {
            planId: id(req),
            version: latest.version + 1,
            schedule: sales.planData(b.schedule),
            createdBy: ctx.actor.id,
          },
        });
      }),
  );
  endpoint(
    app,
    'get',
    root + '/payment-plans',
    {
      permission: 'bookings.read',
      summary: 'List plans and immutable versions',
      query: paginationQuery.extend({ search: z.string().max(200).optional() }),
    },
    async (ctx, _b, q) => {
      const where: Prisma.PaymentPlanWhereInput = {
        projectId: ctx.projectId,
        ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
      };
      const [items, total] = await Promise.all([
        db.paymentPlan.findMany({
          where,
          include: { versions: { orderBy: { version: 'desc' } } },
          ...pagination(q),
          orderBy: [{ createdAt: q.sort }, { id: q.sort }],
        }),
        db.paymentPlan.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/bookings',
    {
      permission: 'bookings.create',
      summary: 'Convert valid reservation into booking and installments',
      body: z
        .object({
          reservationId: uuid,
          planVersionId: uuid,
          discount: money.default('0'),
          discountApprovalId: uuid.optional(),
          dealerId: uuid.optional(),
          owners: z
            .array(
              z
                .object({
                  customerId: uuid,
                  share: positiveMoney.refine((v) => decimal(v).lte(100)),
                })
                .strict(),
            )
            .min(1)
            .max(20)
            .optional(),
        })
        .strict(),
      status: 201,
    },
    async (ctx, b) => sales.createBooking(ctx, b),
  );
  endpoint(
    app,
    'get',
    root + '/bookings',
    {
      permission: 'bookings.read',
      summary: 'List project bookings',
      query: pageQuery.extend({ status: z.enum(BookingStatus).optional() }),
    },
    async (ctx, _b, q) => {
      const where: Prisma.BookingWhereInput = {
        unit: { projectId: ctx.projectId },
        status: q.status,
        ...(q.search ? { reference: { contains: q.search, mode: 'insensitive' } } : {}),
      };
      const [items, total] = await Promise.all([
        db.booking.findMany({ where, ...pagination(q), orderBy: { createdAt: q.sort } }),
        db.booking.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    root + '/bookings/:id',
    { permission: 'bookings.read', summary: 'Booking with ownership history and payment position' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const booking = await sales.scopedBooking(tx, ctx, id(req));
        const project = found(await tx.project.findUnique({ where: { id: ctx.projectId } }));
        return {
          ...booking,
          owners: await tx.bookingOwner.findMany({ where: { bookingId: booking.id } }),
          position: await sales.bookingPosition(tx, booking.id, new Date(), project.graceDays),
          revisions: await tx.scheduleRevision.findMany({ where: { bookingId: booking.id } }),
        };
      }),
  );
  endpoint(
    app,
    'post',
    root + '/bookings/:id/confirm',
    {
      permission: 'bookings.approve',
      summary: 'Confirm approved booking after cleared down payment',
      body: z.object({ approvalId: uuid }).strict(),
    },
    async (ctx, b, _q, req) => sales.confirmBooking(ctx, id(req), b.approvalId),
  );
  const revisionBody = z
    .object({ reason: z.string().min(3).max(1000), schedule: sales.revisedSchedule })
    .strict();
  endpoint(
    app,
    'post',
    root + '/bookings/:id/reschedule-requests',
    {
      permission: 'bookings.create',
      summary: 'Request revision of unpaid installment schedule',
      body: revisionBody,
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const booking = await sales.scopedBooking(tx, ctx, id(req));
        return requestApproval(tx, ctx, 'RESCHEDULE', booking.id, booking.total.toFixed(2), b);
      }),
  );
  endpoint(
    app,
    'post',
    root + '/bookings/:id/reschedule',
    {
      permission: 'bookings.approve',
      summary: 'Apply approved revision retaining paid installment history',
      body: revisionBody.extend({ approvalId: uuid }),
    },
    async (ctx, b, _q, req) => sales.reschedule(ctx, id(req), b.approvalId, b.reason, b.schedule),
  );
  endpoint(
    app,
    'post',
    root + '/payments',
    {
      permission: 'payments.create',
      summary: 'Record pending payment; requires Idempotency-Key',
      body: z
        .object({
          bookingId: uuid,
          amount: positiveMoney,
          method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'PAY_ORDER', 'ONLINE', 'OTHER']),
          paidAt: z.iso.datetime(),
          transactionReference: z.string().max(200).optional(),
          receivingAccountId: uuid,
        })
        .strict(),
      status: 201,
    },
    async (ctx, b, _q, req) => sales.createPayment(ctx, b, idempotencyKey(req)),
  );
  endpoint(
    app,
    'get',
    root + '/payments',
    {
      permission: 'payments.read',
      summary: 'List project collections',
      query: pageQuery.extend({
        status: z.enum(PaymentStatus).optional(),
        bookingId: uuid.optional(),
      }),
    },
    async (ctx, _b, q) => {
      const where: Prisma.PaymentWhereInput = {
        booking: { unit: { projectId: ctx.projectId } },
        bookingId: q.bookingId,
        status: q.status,
        ...(q.from || q.to
          ? {
              paidAt: {
                gte: q.from ? new Date(q.from) : undefined,
                lt: q.to ? new Date(new Date(q.to).getTime() + 86400000) : undefined,
              },
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.payment.findMany({
          where,
          ...pagination(q),
          include: { receipt: true },
          orderBy: { createdAt: q.sort },
        }),
        db.payment.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/payments/:id/verify',
    {
      permission: 'payments.verify',
      summary: 'Clear, reject or bounce payment; requires Idempotency-Key',
      body: z
        .object({
          decision: z.enum(['CLEARED', 'REJECTED', 'BOUNCED']),
          reason: z.string().min(3).max(1000),
        })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      sales.verifyPayment(ctx, id(req), b.decision, b.reason, idempotencyKey(req)),
  );
  endpoint(
    app,
    'post',
    root + '/payments/:id/reversal-requests',
    { permission: 'payments.reverse', summary: 'Request payment reversal' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const p = found(
          await tx.payment.findFirst({
            where: { id: id(req), booking: { unit: { projectId: ctx.projectId } } },
          }),
        );
        requireState(
          p.status === 'CLEARED',
          'PAYMENT_NOT_CLEARED',
          'Only cleared payments can be reversed.',
        );
        return requestApproval(tx, ctx, 'PAYMENT_REVERSAL', p.id, p.amount.toFixed(2));
      }),
  );
  endpoint(
    app,
    'post',
    root + '/payments/:id/allocate-advance',
    {
      permission: 'payments.verify',
      summary: 'Allocate cleared excess credit to remaining installments',
    },
    async (ctx, _b, _q, req) => sales.allocateAdvance(ctx, id(req)),
  );
  endpoint(
    app,
    'post',
    root + '/payments/:id/reverse',
    {
      permission: 'payments.reverse',
      summary: 'Reverse payment, receipt, allocations and journal atomically',
      body: z.object({ approvalId: uuid, reason: z.string().min(3).max(1000) }).strict(),
    },
    async (ctx, b, _q, req) => sales.reversePayment(ctx, id(req), b.approvalId, b.reason),
  );
  endpoint(
    app,
    'get',
    root + '/receipts/:id',
    { permission: 'payments.read', summary: 'Retrieve issued or reversed receipt' },
    async (ctx, _b, _q, req) =>
      found(
        await db.receipt.findFirst({
          where: { id: id(req), payment: { booking: { unit: { projectId: ctx.projectId } } } },
          include: { payment: true },
        }),
      ),
  );
}
