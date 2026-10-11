import { z } from 'zod';
import { DateTime } from 'luxon';
import { requireImage } from '../images/service.js';
import { Prisma } from '@prisma/client';
import { db, transaction, lock, type Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { found, requireState } from '../../common/errors.js';
import { decimal, money, sum, splitAmount } from '../../common/money.js';
import { audit, reference, outbox, idempotent, json } from '../../common/operations.js';
import { scopedUnit, unitState } from '../inventory/service.js';
import { consume, requestApproval } from '../approvals/service.js';
import { postJournal, mappedAccount, reverseJournal } from '../finance/service.js';
export const scheduleSchema = z
  .array(
    z
      .object({
        label: z.string().min(1).max(100),
        percent: money.refine((v) => decimal(v).gt(0) && decimal(v).lte(100)),
        months: z.number().int().min(0).max(360).default(0),
        days: z.number().int().min(0).max(10000).default(0),
        date: z.iso.date().optional(),
      })
      .strict(),
  )
  .min(1)
  .max(360)
  .refine((rows) => sum(rows.map((r) => r.percent)).eq(100), 'Schedule percentages must total 100');
export async function scopedBooking(tx: Tx, ctx: Context, id: string) {
  await lock(tx, 'Booking', id);
  return found(
    await tx.booking.findFirst({
      where: { id, unit: { projectId: ctx.projectId } },
      include: {
        unit: true,
        customer: { select: { id: true, name: true } },
        owners: { where: { validTo: null } },
      },
    }),
  );
}
export async function expireUnit(tx: Tx, ctx: Context, unitId: string) {
  const expired = await tx.reservation.updateMany({
    where: { unitId, status: 'ACTIVE', expiresAt: { lte: new Date() } },
    data: { status: 'EXPIRED' },
  });
  if (expired.count) await unitState(tx, ctx, unitId, 'AVAILABLE', 'Reservation expired');
}
export async function reserve(ctx: Context, input: { unitId: string; customerId: string }) {
  return transaction(async (tx) => {
    await scopedUnit(tx, ctx, input.unitId);
    await expireUnit(tx, ctx, input.unitId);
    const unit = found(await tx.unit.findUnique({ where: { id: input.unitId } }));
    requireState(
      unit.status === 'AVAILABLE',
      'UNIT_ALREADY_RESERVED',
      'This property is no longer available.',
    );
    found(
      await tx.customer.findFirst({ where: { id: input.customerId, projectId: ctx.projectId } }),
    );
    const project = found(await tx.project.findUnique({ where: { id: ctx.projectId } }));
    const reservation = await tx.reservation.create({
      data: {
        ...input,
        reference: await reference(tx, 'RSV'),
        expiresAt: new Date(Date.now() + project.reservationMinutes * 60000),
        createdBy: ctx.actor.id,
      },
    });
    await unitState(tx, ctx, unit.id, 'RESERVED', 'Reservation ' + reservation.reference);
    return reservation;
  });
}
export async function cancelReservation(ctx: Context, reservationId: string) {
  return transaction(async (tx) => {
    const row = found(
      await tx.reservation.findFirst({
        where: { id: reservationId, unit: { projectId: ctx.projectId } },
      }),
    );
    await scopedUnit(tx, ctx, row.unitId);
    const current = found(await tx.reservation.findUnique({ where: { id: row.id } }));
    requireState(
      current.status === 'ACTIVE',
      'RESERVATION_CLOSED',
      'Only active reservations can be cancelled.',
    );
    await tx.reservation.update({ where: { id: row.id }, data: { status: 'CANCELLED' } });
    await unitState(tx, ctx, row.unitId, 'AVAILABLE', 'Reservation cancelled');
    return { cancelled: true };
  });
}
export async function createBooking(
  ctx: Context,
  input: {
    reservationId: string;
    planVersionId: string;
    discount: string;
    discountApprovalId?: string;
    dealerId?: string;
    owners?: { customerId: string; share: string }[];
  },
) {
  return transaction(async (tx) => {
    const reservation = found(
      await tx.reservation.findFirst({
        where: { id: input.reservationId, unit: { projectId: ctx.projectId } },
      }),
    );
    const unit = await scopedUnit(tx, ctx, reservation.unitId);
    const current = found(await tx.reservation.findUnique({ where: { id: reservation.id } }));
    requireState(
      current.status === 'ACTIVE' && current.expiresAt > new Date() && unit.status === 'RESERVED',
      'RESERVATION_EXPIRED',
      'A valid active reservation is required.',
    );
    const plan = found(
      await tx.paymentPlanVersion.findFirst({
        where: { id: input.planVersionId, plan: { projectId: ctx.projectId } },
      }),
    );
    const schedule = scheduleSchema.parse(plan.schedule);
    const discount = decimal(input.discount);
    const total = unit.price.plus(unit.charges).minus(discount);
    requireState(total.gt(0), 'INVALID_PRICE', 'Booking total must be positive.', 422);
    if (discount.gt(0)) {
      requireState(
        input.discountApprovalId,
        'DISCOUNT_APPROVAL_REQUIRED',
        'An approved discount is required.',
      );
      await consume(tx, ctx, input.discountApprovalId, 'DISCOUNT', unit.id, {
        amount: input.discount,
      });
    }
    if (input.dealerId)
      found(
        await tx.dealer.findFirst({
          where: { id: input.dealerId, projectId: ctx.projectId, active: true },
        }),
      );
    const owners = input.owners ?? [{ customerId: reservation.customerId, share: '100' }];
    requireState(
      sum(owners.map((o) => o.share)).eq(100) &&
        new Set(owners.map((o) => o.customerId)).size === owners.length,
      'INVALID_OWNERSHIP',
      'Unique ownership shares must total 100.',
      422,
    );
    requireState(
      owners.some((o) => o.customerId === reservation.customerId),
      'INVALID_OWNERSHIP',
      'The reserved customer must be an owner.',
      422,
    );
    requireState(
      (await tx.customer.count({
        where: { projectId: ctx.projectId, id: { in: owners.map((o) => o.customerId) } },
      })) === owners.length,
      'INVALID_OWNERSHIP',
      'Owners must belong to the project.',
      422,
    );
    const project = found(await tx.project.findUnique({ where: { id: ctx.projectId } }));
    const booking = await tx.booking.create({
      data: {
        reference: await reference(tx, 'BKG'),
        unitId: unit.id,
        customerId: reservation.customerId,
        reservationId: reservation.id,
        planVersionId: plan.id,
        dealerId: input.dealerId,
        basePrice: unit.price,
        charges: unit.charges,
        discount,
        total,
        downPayment: total.mul(project.downPaymentPercent).div(100).toDecimalPlaces(2),
        createdBy: ctx.actor.id,
        owners: { create: owners },
      },
    });
    const amounts = splitAmount(
      total,
      schedule.map((s) => s.percent),
    );
    requireState(
      amounts.every((a) => a.gt(0)),
      'INSTALLMENT_TOO_SMALL',
      'Every generated installment must be at least one cent.',
      422,
    );
    const today = DateTime.now().setZone(project.timezone).startOf('day');
    await tx.installment.createMany({
      data: schedule.map((s, i) => ({
        bookingId: booking.id,
        sequence: i + 1,
        version: 1,
        label: s.label,
        amount: amounts[i]!,
        dueDate: new Date(s.date ?? today.plus({ months: s.months, days: s.days }).toISODate()!),
      })),
    });
    await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'CONVERTED' } });
    await unitState(tx, ctx, unit.id, 'BOOKED', 'Booking draft ' + booking.reference);
    const approval = await requestApproval(tx, ctx, 'BOOKING', booking.id, total.toFixed(2));
    await audit(tx, ctx, 'booking.created', booking.id);
    return { booking, approval };
  });
}
export async function clearedTotal(tx: Tx, bookingId: string) {
  const aggregate = await tx.payment.aggregate({
    where: { bookingId, status: 'CLEARED' },
    _sum: { amount: true },
  });
  return aggregate._sum.amount ?? decimal(0);
}
export async function confirmBooking(ctx: Context, bookingId: string, approvalId: string) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, bookingId);
    await scopedUnit(tx, ctx, booking.unitId);
    requireState(
      booking.status === 'DRAFT' && booking.unit.status === 'BOOKED',
      'BOOKING_NOT_DRAFT',
      'Only an unconfirmed booking can be confirmed.',
    );
    requireState(
      (await clearedTotal(tx, booking.id)).gte(booking.downPayment),
      'DOWN_PAYMENT_REQUIRED',
      'Cleared down payment is required.',
    );
    await consume(tx, ctx, approvalId, 'BOOKING', booking.id);
    const result = await tx.booking.update({
      where: { id: booking.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), approvedBy: ctx.actor.id },
    });
    await unitState(tx, ctx, booking.unitId, 'SOLD', 'Booking confirmed');
    if (booking.dealerId) {
      const dealer = found(await tx.dealer.findUnique({ where: { id: booking.dealerId } }));
      const amount = booking.total.mul(dealer.commissionPercent).div(100).toDecimalPlaces(2);
      if (amount.gt(0)) {
        const commission = await tx.dealerCommission.create({
          data: { dealerId: dealer.id, bookingId: booking.id, amount },
        });
        await requestApproval(tx, ctx, 'COMMISSION', commission.id, amount.toFixed(2));
      }
    }
    await audit(tx, ctx, 'booking.confirmed', booking.id);
    await outbox(tx, 'business-event', {
      projectId: ctx.projectId,
      kind: 'Booking confirmed',
      entityId: booking.id,
    });
    return result;
  });
}
export async function createPayment(
  ctx: Context,
  input: {
    bookingId: string;
    amount: string;
    method: string;
    paidAt: string;
    transactionReference?: string;
    proofImageId?: string;
    methodDetails?: string;
    receivingAccountId: string;
  },
  key: string,
) {
  return transaction(async (tx) =>
    idempotent(tx, ctx, 'payment.create', key, input, async () => {
      const booking = await scopedBooking(tx, ctx, input.bookingId);
      requireState(
        booking.status !== 'CANCELLED',
        'BOOKING_CANCELLED',
        'Payments cannot be received for cancelled bookings.',
      );
      const account = found(
        await tx.account.findFirst({
          where: { id: input.receivingAccountId, projectId: ctx.projectId, active: true },
        }),
      );
      requireState(
        account.type === 'ASSET',
        'INVALID_ACCOUNT',
        'Receiving account must be an asset account.',
        422,
      );
      requireState(
        new Date(input.paidAt).getTime() <= Date.now() + 60000,
        'FUTURE_PAYMENT',
        'Payment date cannot be in the future.',
        422,
      );
      requireState(
        input.method === 'CASH' || input.proofImageId,
        'PAYMENT_PROOF_REQUIRED',
        'Upload a payment proof image for non-cash payments.',
        422,
      );
      requireState(
        input.method !== 'OTHER' || input.methodDetails?.trim(),
        'PAYMENT_METHOD_DETAILS_REQUIRED',
        'Describe how this payment was made.',
        422,
      );
      await requireImage(tx, ctx, input.proofImageId, 'PAYMENT');
      const payment = await tx.payment.create({
        data: {
          ...input,
          payerId: booking.customerId,
          paidAt: new Date(input.paidAt),
          receivedBy: ctx.actor.id,
        },
      });
      await audit(tx, ctx, 'payment.created', payment.id, { amount: input.amount });
      return payment;
    }),
  );
}
export async function verifyPayment(
  ctx: Context,
  paymentId: string,
  decision: 'CLEARED' | 'REJECTED' | 'BOUNCED',
  reason: string,
  key: string,
) {
  return transaction(async (tx) =>
    idempotent(tx, ctx, 'payment.verify', key, { paymentId, decision, reason }, async () => {
      const initial = found(
        await tx.payment.findFirst({
          where: { id: paymentId, booking: { unit: { projectId: ctx.projectId } } },
        }),
      );
      const booking = await scopedBooking(tx, ctx, initial.bookingId);
      await lock(tx, 'Payment', paymentId);
      const payment = found(await tx.payment.findUnique({ where: { id: paymentId } }));
      requireState(
        payment.status === 'PENDING',
        'PAYMENT_ALREADY_PROCESSED',
        'This payment has already been processed.',
      );
      requireState(
        payment.receivedBy !== ctx.actor.id,
        'SELF_VERIFICATION_FORBIDDEN',
        'A different user must verify this payment.',
        403,
      );
      requireState(
        booking.status !== 'CANCELLED',
        'BOOKING_CANCELLED',
        'The booking is cancelled.',
      );
      if (decision === 'BOUNCED')
        requireState(
          payment.method === 'CHEQUE',
          'INVALID_PAYMENT_TRANSITION',
          'Only cheques can bounce.',
          422,
        );
      if (decision === 'CLEARED') {
        let remaining = payment.amount;
        const installments = await tx.installment.findMany({
          where: { bookingId: booking.id, superseded: false },
          include: { allocations: { where: { reversedAt: null } } },
          orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
        });
        for (const installment of installments) {
          const due = installment.amount.minus(sum(installment.allocations.map((a) => a.amount)));
          const amount = Prisma.Decimal.min(due, remaining);
          if (amount.gt(0)) {
            await tx.paymentAllocation.create({
              data: { paymentId: payment.id, installmentId: installment.id, amount },
            });
            remaining = remaining.minus(amount);
          }
          if (remaining.eq(0)) break;
        }
        await tx.receipt.create({
          data: { paymentId: payment.id, reference: await reference(tx, 'RCT') },
        });
        await postJournal(tx, ctx, {
          source: 'PAYMENT',
          sourceId: payment.id,
          description: 'Verified collection',
          lines: [
            { accountId: payment.receivingAccountId, debit: payment.amount, credit: 0 },
            {
              accountId: await mappedAccount(tx, ctx.projectId, 'advances'),
              debit: 0,
              credit: payment.amount,
            },
          ],
        });
        await outbox(tx, 'business-event', {
          projectId: ctx.projectId,
          kind: 'Payment receipt',
          entityId: payment.id,
        });
      }
      await tx.paymentVerification.create({
        data: { paymentId: payment.id, actorId: ctx.actor.id, status: decision, reason },
      });
      const result = await tx.payment.update({
        where: { id: payment.id },
        data: { status: decision, verifiedAt: new Date(), verifiedBy: ctx.actor.id },
        include: {
          receipt: true,
          allocations: {
            orderBy: [
              { installment: { dueDate: 'asc' } },
              { installment: { sequence: 'asc' } },
              { installmentId: 'asc' },
            ],
          },
        },
      });
      await audit(tx, ctx, 'payment.verified', payment.id, { decision });
      return result;
    }),
  );
}
export async function reversePayment(
  ctx: Context,
  paymentId: string,
  approvalId: string,
  reason: string,
) {
  return transaction(async (tx) => {
    const initial = found(
      await tx.payment.findFirst({
        where: { id: paymentId, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    const booking = await scopedBooking(tx, ctx, initial.bookingId);
    await lock(tx, 'Payment', paymentId);
    const payment = found(await tx.payment.findUnique({ where: { id: paymentId } }));
    requireState(
      payment.status === 'CLEARED',
      'PAYMENT_NOT_CLEARED',
      'Only cleared payments may be reversed.',
    );
    requireState(
      booking.status !== 'CANCELLED' &&
        !(await tx.transfer.findFirst({ where: { bookingId: booking.id, status: 'COMPLETED' } })) &&
        !(await tx.possession.findFirst({ where: { bookingId: booking.id, status: 'COMPLETED' } })),
      'OWNERSHIP_ALREADY_FINALIZED',
      'Resolve finalized ownership or cancellation before payment reversal.',
    );
    await consume(tx, ctx, approvalId, 'PAYMENT_REVERSAL', payment.id);
    const journal = found(
      await tx.journal.findUnique({
        where: { source_sourceId: { source: 'PAYMENT', sourceId: payment.id } },
      }),
    );
    await reverseJournal(tx, ctx, journal.id, reason);
    await tx.paymentAllocation.updateMany({
      where: { paymentId: payment.id, reversedAt: null },
      data: { reversedAt: new Date() },
    });
    await tx.receipt.update({ where: { paymentId: payment.id }, data: { reversedAt: new Date() } });
    await tx.paymentVerification.create({
      data: { paymentId: payment.id, actorId: ctx.actor.id, status: 'REVERSED', reason },
    });
    const result = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'REVERSED' },
    });
    await audit(tx, ctx, 'payment.reversed', payment.id, { reason });
    await outbox(tx, 'business-event', {
      projectId: ctx.projectId,
      kind: 'Payment reversed',
      entityId: payment.id,
    });
    return result;
  });
}
export async function allocateAdvance(ctx: Context, paymentId: string) {
  return transaction(async (tx) => {
    const initial = found(
      await tx.payment.findFirst({
        where: { id: paymentId, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    const booking = await scopedBooking(tx, ctx, initial.bookingId);
    await lock(tx, 'Payment', paymentId);
    const payment = found(
      await tx.payment.findUnique({
        where: { id: paymentId },
        include: { allocations: { where: { reversedAt: null } } },
      }),
    );
    requireState(
      payment.status === 'CLEARED' && booking.status !== 'CANCELLED',
      'PAYMENT_NOT_ALLOCATABLE',
      'Only cleared payments on active bookings can allocate credit.',
    );
    let remaining = payment.amount.minus(sum(payment.allocations.map((a) => a.amount)));
    const installments = await tx.installment.findMany({
      where: { bookingId: booking.id, superseded: false },
      include: { allocations: { where: { reversedAt: null } } },
      orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
    });
    for (const installment of installments) {
      const amount = Prisma.Decimal.min(
        remaining,
        installment.amount.minus(sum(installment.allocations.map((a) => a.amount))),
      );
      if (amount.gt(0)) {
        await tx.paymentAllocation.upsert({
          where: { paymentId_installmentId: { paymentId, installmentId: installment.id } },
          create: { paymentId, installmentId: installment.id, amount },
          update: { amount: { increment: amount } },
        });
        remaining = remaining.minus(amount);
      }
      if (remaining.eq(0)) break;
    }
    await audit(tx, ctx, 'payment.advance_allocated', paymentId, {
      remaining: remaining.toFixed(2),
    });
    return tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        allocations: {
          orderBy: [
            { installment: { dueDate: 'asc' } },
            { installment: { sequence: 'asc' } },
            { installmentId: 'asc' },
          ],
        },
        receipt: true,
      },
    });
  });
}
export async function bookingPosition(tx: Tx, bookingId: string, asOf = new Date(), graceDays = 0) {
  const booking = found(
    await tx.booking.findUnique({
      where: { id: bookingId },
      include: { unit: { include: { project: true } } },
    }),
  );
  const businessDay = new Date(
    DateTime.fromJSDate(asOf).setZone(booking.unit.project.timezone).toISODate()!,
  ).getTime();
  const rows = await tx.installment.findMany({
    where: { bookingId, superseded: false },
    include: { allocations: { where: { reversedAt: null } } },
    orderBy: { dueDate: 'asc' },
  });
  const installments = rows.map((row) => {
    const paid = sum(row.allocations.map((a) => a.amount));
    const outstanding = row.amount.minus(paid);
    const lateDays = Math.max(
      0,
      Math.floor((businessDay - row.dueDate.getTime()) / 86400000) - graceDays,
    );
    return {
      ...row,
      allocations: undefined,
      paid: paid.toFixed(2),
      outstanding: outstanding.toFixed(2),
      lateDays,
      overdue: lateDays > 0 ? outstanding.toFixed(2) : '0.00',
    };
  });
  const collected = await clearedTotal(tx, bookingId);
  const allocated = sum(installments.map((i) => i.paid));
  return {
    installments,
    collected: collected.toFixed(2),
    unallocated: collected.minus(allocated).toFixed(2),
    outstanding: sum(installments.map((i) => i.outstanding)).toFixed(2),
    overdue: sum(installments.map((i) => i.overdue)).toFixed(2),
  };
}
export const revisedSchedule = z
  .array(
    z
      .object({
        label: z.string().min(1).max(100),
        dueDate: z.iso.date(),
        amount: money.refine((v) => decimal(v).gt(0)),
      })
      .strict(),
  )
  .min(1)
  .max(360);
export async function reschedule(
  ctx: Context,
  bookingId: string,
  approvalId: string,
  reason: string,
  schedule: z.infer<typeof revisedSchedule>,
) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, bookingId);
    requireState(
      booking.status !== 'CANCELLED',
      'BOOKING_CANCELLED',
      'Cannot revise a cancelled booking.',
    );
    await consume(tx, ctx, approvalId, 'RESCHEDULE', booking.id, { reason, schedule });
    const rows = await tx.installment.findMany({
      where: { bookingId, superseded: false },
      include: { allocations: { where: { reversedAt: null } } },
    });
    const unpaid = rows.filter((r) => r.allocations.length === 0);
    requireState(
      sum(unpaid.map((r) => r.amount)).eq(sum(schedule.map((s) => s.amount))),
      'SCHEDULE_TOTAL_MISMATCH',
      'Revised total must equal wholly unpaid installments. Paid or partially paid installments are retained.',
      422,
    );
    const version = booking.scheduleVersion + 1;
    await tx.installment.updateMany({
      where: { id: { in: unpaid.map((r) => r.id) } },
      data: { superseded: true },
    });
    await tx.installment.createMany({
      data: schedule.map((s, i) => ({
        ...s,
        bookingId,
        version,
        sequence: i + 1,
        dueDate: new Date(s.dueDate),
      })),
    });
    await tx.scheduleRevision.create({
      data: { bookingId, version, reason, approvedBy: ctx.actor.id },
    });
    await tx.booking.update({ where: { id: bookingId }, data: { scheduleVersion: version } });
    await audit(tx, ctx, 'booking.rescheduled', bookingId, { version });
    return bookingPosition(tx, bookingId);
  });
}
export async function expireReservations() {
  const rows = await db.reservation.findMany({
    where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
    select: { unitId: true, createdBy: true, unit: { select: { projectId: true } } },
    take: 500,
  });
  for (const row of rows)
    await transaction(async (tx) => {
      const ctx = {
        actor: { id: row.createdBy, sessionId: '', permissions: new Set<string>() },
        projectId: row.unit.projectId,
        requestId: 'reservation-expiry',
      };
      await scopedUnit(tx, ctx, row.unitId);
      await expireUnit(tx, ctx, row.unitId);
    });
  return rows.length;
}
export const planData = (schedule: z.infer<typeof scheduleSchema>) => json(schedule);
