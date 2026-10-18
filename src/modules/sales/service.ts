import { z } from 'zod';
import { DateTime } from 'luxon';
import { requireImage } from '../images/service.js';
import { Prisma } from '@prisma/client';
import { transaction, lock, type Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { found, requireState } from '../../common/errors.js';
import { decimal, sum } from '../../common/money.js';
import { audit, reference, outbox, idempotent, json } from '../../common/operations.js';
import { scopedUnit, unitState } from '../inventory/service.js';
import { bookingInput, calculatePaymentPlan, equalInstallments } from './payment-plan.js';
import { postJournal, mappedAccount, reverseJournal } from '../finance/service.js';
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
export async function createBooking(ctx: Context, input: z.infer<typeof bookingInput>) {
  return transaction(async (tx) => {
    const unit = await scopedUnit(tx, ctx, input.unitId);
    requireState(
      unit.status === 'AVAILABLE' &&
        !(await tx.booking.findFirst({ where: { unitId: unit.id, status: { not: 'CANCELLED' } } })),
      'PROPERTY_UNAVAILABLE',
      'This property has already been booked or is unavailable. Choose another property.',
      409,
    );
    const customer = found(
      await tx.customer.findFirst({ where: { id: input.customerId, projectId: ctx.projectId } }),
    );
    if (input.confirm)
      requireState(
        ctx.actor.permissions.has('bookings.approve'),
        'FORBIDDEN',
        'You do not have permission to confirm bookings.',
        403,
      );
    const basePrice = decimal(input.sellingPrice ?? unit.price);
    if (!basePrice.eq(unit.price))
      requireState(
        ctx.actor.permissions.has('inventory.change_price'),
        'FORBIDDEN',
        'You do not have permission to change the selling price.',
        403,
      );
    const discount = decimal(input.discount);
    if (discount.gt(0))
      requireState(
        ctx.actor.permissions.has('discounts.approve'),
        'FORBIDDEN',
        'You do not have permission to apply discounts.',
        403,
      );
    requireState(
      discount.lte(basePrice),
      'INVALID_DISCOUNT',
      'Discount cannot exceed the selling price.',
      422,
    );
    const total = basePrice.plus(unit.charges).minus(discount);
    const owners = input.owners ?? [{ customerId: customer.id, share: '100' }];
    requireState(
      sum(owners.map((o) => o.share)).eq(100) &&
        new Set(owners.map((o) => o.customerId)).size === owners.length &&
        owners.some((o) => o.customerId === customer.id),
      'INVALID_OWNERSHIP',
      'Unique ownership shares must total 100 and include the selected customer.',
      422,
    );
    requireState(
      (await tx.customer.count({
        where: { projectId: ctx.projectId, id: { in: owners.map((o) => o.customerId) } },
      })) === owners.length,
      'INVALID_OWNERSHIP',
      'All owners must belong to this project.',
      422,
    );
    const project = found(await tx.project.findUnique({ where: { id: ctx.projectId } }));
    const today = DateTime.now().setZone(project.timezone).toISODate()!;
    const calculated = calculatePaymentPlan(total, input, project.downPaymentPercent, today);
    const booking = await tx.booking.create({
      data: {
        reference: await reference(tx, 'BKG'),
        unitId: unit.id,
        customerId: customer.id,
        basePrice,
        charges: unit.charges,
        discount,
        total,
        downPayment: calculated.downPayment,
        paymentType: input.paymentType,
        paymentTerms: json({
          paymentType: input.paymentType,
          downPayment: calculated.downPayment.toFixed(2),
          installmentCount: input.installmentCount,
          intervalMonths: input.intervalMonths,
          firstInstallmentDate: input.firstInstallmentDate,
        }),
        status: input.confirm ? 'CONFIRMED' : 'DRAFT',
        confirmedAt: input.confirm ? new Date() : null,
        approvedBy: input.confirm ? ctx.actor.id : null,
        createdBy: ctx.actor.id,
        owners: { create: owners },
        installments: {
          create: calculated.schedule.map((row, i) => ({
            ...row,
            sequence: i + 1,
            version: 1,
            dueDate: new Date(row.dueDate),
          })),
        },
      },
      include: { customer: { select: { id: true, name: true } }, unit: true },
    });
    await unitState(
      tx,
      ctx,
      unit.id,
      input.confirm ? 'SOLD' : 'BOOKED',
      'Booking ' + booking.reference,
    );
    await audit(tx, ctx, 'booking.created', booking.id);
    if (input.confirm)
      await outbox(tx, 'business-event', {
        projectId: ctx.projectId,
        kind: 'Booking confirmed',
        entityId: booking.id,
      });
    return { booking };
  });
}
export async function clearedTotal(tx: Tx, bookingId: string) {
  const aggregate = await tx.payment.aggregate({
    where: { bookingId, status: 'CLEARED' },
    _sum: { amount: true },
  });
  return aggregate._sum.amount ?? decimal(0);
}
export async function confirmBooking(ctx: Context, bookingId: string) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, bookingId);
    await scopedUnit(tx, ctx, booking.unitId);
    requireState(
      booking.status === 'DRAFT' && booking.unit.status === 'BOOKED',
      'BOOKING_NOT_DRAFT',
      'Only an unconfirmed booking can be confirmed.',
    );
    requireState(
      ctx.actor.permissions.has('bookings.approve'),
      'FORBIDDEN',
      'You do not have permission to confirm bookings.',
      403,
    );
    const result = await tx.booking.update({
      where: { id: booking.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), approvedBy: ctx.actor.id },
    });
    await unitState(tx, ctx, booking.unitId, 'SOLD', 'Booking confirmed');

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
    receivingAccountId?: string;
  },
  key: string,
) {
  return transaction(async (tx) =>
    idempotent(tx, ctx, 'payment.create', key, input, async () => {
      const payment = await createPaymentInTransaction(tx, ctx, input);
      if (ctx.actor.isSuperAdmin) {
        return verifyPaymentInTransaction(
          tx,
          ctx,
          payment.id,
          'CLEARED',
          'Approved on recording by administrator',
          true,
        );
      }
      return payment;
    }),
  );
}
type PaymentInput = Parameters<typeof createPayment>[1];
async function createPaymentInTransaction(tx: Tx, ctx: Context, input: PaymentInput) {
      const booking = await scopedBooking(tx, ctx, input.bookingId);
      requireState(
        booking.status !== 'CANCELLED',
        'BOOKING_CANCELLED',
        'Payments cannot be received for cancelled bookings.',
      );
      const account = found(
        await tx.account.findFirst({
          where: {
            id: input.receivingAccountId ?? (await mappedAccount(tx, ctx.projectId, 'cash')),
            projectId: ctx.projectId,
            active: true,
          },
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
        ['CASH', 'CHEQUE'].includes(input.method) || input.proofImageId,
        'PAYMENT_PROOF_REQUIRED',
        'Upload proof for bank transfers and other electronic payments.',
        422,
      );
      requireState(!['CHEQUE', 'BANK_TRANSFER'].includes(input.method) || Boolean(input.transactionReference?.trim()), 'PAYMENT_REFERENCE_REQUIRED', 'Enter the cheque number or bank transaction ID.', 422);
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
          receivingAccountId: account.id,
          payerId: booking.customerId,
          paidAt: new Date(input.paidAt),
          receivedBy: ctx.actor.id,
        },
      });
      await audit(tx, ctx, 'payment.created', payment.id, { amount: input.amount });
      return payment;
}
export async function verifyPayment(
  ctx: Context,
  paymentId: string,
  decision: 'CLEARED' | 'REJECTED' | 'BOUNCED',
  reason: string,
  key: string,
) {
  return transaction(async (tx) =>
    idempotent(tx, ctx, 'payment.verify', key, { paymentId, decision, reason }, () => verifyPaymentInTransaction(tx, ctx, paymentId, decision, reason)),
  );
}
async function verifyPaymentInTransaction(tx: Tx, ctx: Context, paymentId: string, decision: 'CLEARED' | 'REJECTED' | 'BOUNCED', reason: string, approveNewCash = false) {
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
        payment.receivedBy !== ctx.actor.id || ctx.actor.isSuperAdmin || (approveNewCash && ctx.actor.permissions.has('payments.verify')),
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
}
export async function collectInstallment(ctx: Context, installmentId: string,
  input: { expectedAmount: string; method: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER'; paidAt: string; transactionReference?: string; proofImageId?: string; receivingAccountId?: string }, key: string) {
  requireState(ctx.actor.permissions.has('payments.create'), 'FORBIDDEN', 'Payment recording permission is required.', 403);
  requireState(input.method !== 'BANK_TRANSFER' || Boolean(input.receivingAccountId), 'BANK_ACCOUNT_REQUIRED', 'Select the receiving bank account.', 422);
  if (input.method === 'CASH') requireState(ctx.actor.permissions.has('payments.verify'), 'FORBIDDEN', 'Payment verification permission is required to receive and approve cash.', 403);
  return transaction(tx => idempotent(tx, ctx, 'installment.collect', key, { installmentId, ...input }, async () => {
    const installment = found(await tx.installment.findFirst({ where: { id: installmentId, booking: { unit: { projectId: ctx.projectId } } } }));
    const booking = await scopedBooking(tx, ctx, installment.bookingId);
    requireState(booking.status === 'CONFIRMED', 'BOOKING_NOT_CONFIRMED', 'Confirm the booking before receiving an installment.');
    const position = await bookingPosition(tx, booking.id);
    const next = position.installments.find(item => decimal(item.outstanding).gt(0));
    requireState(next?.id === installmentId && !installment.superseded, 'INSTALLMENT_NOT_NEXT', 'Refresh the schedule and select the earliest unpaid installment.');
    requireState(decimal(next.outstanding).eq(input.expectedAmount), 'INSTALLMENT_AMOUNT_CHANGED', 'The outstanding amount changed. Refresh the schedule before recording payment.');
    requireState(!(await tx.payment.findFirst({ where: { bookingId: booking.id, status: 'PENDING' } })), 'PAYMENT_PENDING', 'This booking already has a pending payment. Verify or reject it from Payments received before adding another installment.');
    const { expectedAmount: _amount, ...fields } = input;
    const payment = await createPaymentInTransaction(tx, ctx, { ...fields, bookingId: booking.id, amount: next.outstanding });
    await audit(tx, ctx, 'installment.payment_recorded', installmentId, { paymentId: payment.id });
    return (input.method === 'CASH' && ctx.actor.permissions.has('payments.verify')) || ctx.actor.isSuperAdmin
      ? verifyPaymentInTransaction(tx, ctx, payment.id, 'CLEARED', 'Approved on recording by administrator', true)
      : payment;
  }));
}
export async function reversePayment(ctx: Context, paymentId: string, reason: string) {
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
export async function bookingPosition(tx: Tx, bookingId: string, asOf = new Date()) {
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
    orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
  });
  const installments = rows.map((row) => {
    const paid = sum(row.allocations.map((a) => a.amount));
    const outstanding = row.amount.minus(paid);
    const lateDays = Math.max(0, Math.floor((businessDay - row.dueDate.getTime()) / 86400000));
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
export async function reschedule(
  ctx: Context,
  bookingId: string,
  reason: string,
  terms: { installmentCount: number; intervalMonths: number; firstInstallmentDate: string },
) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, bookingId);
    requireState(
      booking.status !== 'CANCELLED',
      'BOOKING_CANCELLED',
      'Cannot revise a cancelled booking.',
    );
    const rows = await tx.installment.findMany({
      where: { bookingId, superseded: false },
      include: { allocations: { where: { reversedAt: null } } },
    });
    requireState(
      booking.paymentType === 'INSTALLMENTS',
      'FULL_PAYMENT_BOOKING',
      'Full-payment bookings do not need an installment schedule.',
      422,
    );
    requireState(
      (await clearedTotal(tx, booking.id)).gte(booking.downPayment),
      'DOWN_PAYMENT_REQUIRED',
      'Record and verify the down payment before changing the remaining schedule.',
      422,
    );
    const unpaid = rows.filter((r) => r.allocations.length === 0);
    requireState(
      unpaid.length > 0,
      'NO_UNPAID_INSTALLMENTS',
      'There are no completely unpaid installments to change.',
      422,
    );
    const project = found(await tx.project.findUnique({ where: { id: ctx.projectId } }));
    requireState(
      terms.firstInstallmentDate >= DateTime.now().setZone(project.timezone).toISODate()!,
      'INVALID_DATE',
      'Choose a current or future first installment date.',
      422,
    );
    const schedule = equalInstallments(
      sum(unpaid.map((r) => r.amount)),
      terms.installmentCount,
      terms.intervalMonths,
      terms.firstInstallmentDate,
    );
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
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        scheduleVersion: version,
        paymentTerms: json({
          ...terms,
          paymentType: 'INSTALLMENTS',
          downPayment: booking.downPayment.toFixed(2),
        }),
      },
    });
    await audit(tx, ctx, 'booking.rescheduled', bookingId, { version });
    return bookingPosition(tx, bookingId);
  });
}
