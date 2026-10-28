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
import { positiveMoney, sum, decimal } from '../../common/money.js';
import { found } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import * as sales from './service.js';
import { bookingInput, paymentTerms } from './payment-plan.js';
import { dealerRoutes } from './dealers.js';
const root = '/projects/:projectId';
export function salesRoutes(app: Express) {
  dealerRoutes(app);
  endpoint(
    app,
    'post',
    root + '/installments/:id/payment',
    {
      permission: 'payments.create',
      summary:
        'Receive the next installment; approve cash or queue bank/cheque verification; requires Idempotency-Key',
      body: z
        .object({
          expectedAmount: positiveMoney,
          method: z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER']),
          paidAt: z.iso.datetime(),
          transactionReference: z.string().trim().min(1).max(200).optional(),
          proofImageId: uuid.optional(),
          receivingAccountId: uuid.optional(),
        })
        .strict(),
    },
    async (ctx, body, _q, req) => sales.collectInstallment(ctx, id(req), body, idempotencyKey(req)),
  );
  endpoint(
    app,
    'post',
    root + '/payment-plans',
    {
      permission: 'plans.manage',
      summary: 'Save payment plan defaults',
      body: z.object({ name: z.string().min(2).max(200), ...paymentTerms.shape }).strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const plan = await tx.paymentPlan.create({
          data: {
            projectId: ctx.projectId,
            name: b.name,
            versions: {
              create: {
                version: 1,
                schedule: JSON.parse(JSON.stringify(b)),
                createdBy: ctx.actor.id,
              },
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
      summary: 'Update payment plan defaults without changing existing bookings',
      body: paymentTerms,
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
            schedule: JSON.parse(JSON.stringify(b)),
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
      summary: 'Create a booking with a full payment or installment plan',
      body: bookingInput,
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
        ...(q.search
          ? {
              OR: [
                { reference: { contains: q.search, mode: 'insensitive' } },
                { customer: { name: { contains: q.search, mode: 'insensitive' } } },
                { customer: { fatherName: { contains: q.search, mode: 'insensitive' } } },
                { customer: { phone: { contains: q.search } } },
                { customer: { reference: { contains: q.search, mode: 'insensitive' } } },
                { unit: { number: { contains: q.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.booking.findMany({
          where,
          include: {
            customer: {
              select: { id: true, reference: true, name: true, fatherName: true, phone: true },
            },
            unit: {
              select: {
                id: true,
                number: true,
                type: true,
                size: true,
                measurementUnit: true,
                phase: true,
                block: true,
              },
            },
            payments: {
              where: { status: { in: ['CLEARED', 'PENDING'] } },
              select: { amount: true, status: true },
            },
            installments: {
              where: { superseded: false },
              orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
              select: {
                amount: true,
                dueDate: true,
                allocations: { where: { reversedAt: null }, select: { amount: true } },
              },
            },
          },
          ...pagination(q),
          orderBy: { createdAt: q.sort },
        }),
        db.booking.count({ where }),
      ]);
      return paged(
        items.map(({ payments, installments, ...booking }) => {
          const paid = sum(payments.filter((p) => p.status === 'CLEARED').map((p) => p.amount));
          const next = installments.find((i) =>
            i.amount.gt(sum(i.allocations.map((a) => a.amount))),
          );
          return {
            ...booking,
            paid: paid.toFixed(2),
            outstanding: decimal(booking.total).minus(paid).clamp(0, booking.total).toFixed(2),
            pendingPayments: payments.filter((p) => p.status === 'PENDING').length,
            nextDue: next?.dueDate ?? null,
          };
        }),
        total,
        q,
      );
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
        return {
          ...booking,
          owners: await tx.bookingOwner.findMany({
            where: { bookingId: booking.id },
            include: { customer: { select: { name: true } } },
          }),
          position: await sales.bookingPosition(tx, booking.id, new Date()),
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
      summary: 'Confirm booking',
    },
    async (ctx, b, _q, req) => sales.confirmBooking(ctx, id(req)),
  );
  const revisionBody = z
    .object({
      reason: z.string().min(3).max(1000),
      installmentCount: z.number().int().min(1).max(360),
      intervalMonths: z.number().int().min(1).max(12),
      firstInstallmentDate: z.iso.date(),
    })
    .strict();
  endpoint(
    app,
    'post',
    root + '/bookings/:id/reschedule',
    {
      permission: 'bookings.approve',
      summary: 'Save payment plan and retain paid installment history',
      body: revisionBody,
    },
    async (ctx, b, _q, req) => sales.reschedule(ctx, id(req), b.reason, b),
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
          proofImageId: uuid.optional(),
          methodDetails: z.string().trim().min(2).max(200).optional(),
          receivingAccountId: uuid.optional(),
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
          include: {
            receipt: true,
            booking: { select: { reference: true, customer: { select: { name: true } } } },
          },
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
      body: z.object({ reason: z.string().min(3).max(1000) }).strict(),
    },
    async (ctx, b, _q, req) => sales.reversePayment(ctx, id(req), b.reason),
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
          include: {
            payment: {
              include: {
                booking: { select: { reference: true, customer: { select: { name: true } } } },
              },
            },
          },
        }),
      ),
  );
}
