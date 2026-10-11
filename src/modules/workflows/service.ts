import { transaction, lock, type Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { found, requireState } from '../../common/errors.js';
import { decimal, sum } from '../../common/money.js';
import { audit, reference, outbox } from '../../common/operations.js';
import { scopedBooking, bookingPosition, clearedTotal } from '../sales/service.js';
import { scopedUnit, unitState } from '../inventory/service.js';
import { consume, requestApproval } from '../approvals/service.js';
import { postJournal, mappedAccount } from '../finance/service.js';
async function settled(tx: Tx, bookingId: string) {
  const position = await bookingPosition(tx, bookingId);
  requireState(
    decimal(position.outstanding).eq(0),
    'OUTSTANDING_DUES',
    'All scheduled dues must be cleared.',
  );
}
export async function requestNdc(
  ctx: Context,
  input: { bookingId: string; identityVerified: boolean; documentsVerified: boolean },
) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, input.bookingId);
    requireState(
      booking.status === 'CONFIRMED',
      'BOOKING_NOT_CONFIRMED',
      'A confirmed booking is required.',
    );
    requireState(
      input.identityVerified && input.documentsVerified,
      'VERIFICATION_REQUIRED',
      'Identity and supporting documents must be verified.',
      422,
    );
    await settled(tx, booking.id);
    const ndc = await tx.ndc.create({
      data: { ...input, reference: await reference(tx, 'NDC'), requestedBy: ctx.actor.id },
    });
    const approval = await requestApproval(tx, ctx, 'NDC', ndc.id, '0');
    return { ndc, approval };
  });
}
export async function issueNdc(ctx: Context, id: string, approvalId: string) {
  return transaction(async (tx) => {
    const ndc = found(
      await tx.ndc.findFirst({ where: { id, booking: { unit: { projectId: ctx.projectId } } } }),
    );
    const booking = await scopedBooking(tx, ctx, ndc.bookingId);
    requireState(
      booking.status === 'CONFIRMED' && ndc.status === 'PENDING',
      'INVALID_NDC_STATE',
      'A pending NDC for a confirmed booking is required.',
    );
    await settled(tx, booking.id);
    await consume(tx, ctx, approvalId, 'NDC', id);
    const project = found(await tx.project.findUnique({ where: { id: ctx.projectId } }));
    const result = await tx.ndc.update({
      where: { id },
      data: {
        status: 'APPROVED',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + project.ndcValidityDays * 86400000),
      },
    });
    await audit(tx, ctx, 'ndc.issued', id);
    await outbox(tx, 'business-event', {
      projectId: ctx.projectId,
      kind: 'NDC issued',
      entityId: id,
    });
    return result;
  });
}
export async function requestTransfer(
  ctx: Context,
  input: { bookingId: string; buyerId: string; ndcId: string; charges: string },
) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, input.bookingId);
    const unit = await scopedUnit(tx, ctx, booking.unitId);
    requireState(
      booking.status === 'CONFIRMED' && unit.status === 'SOLD',
      'TRANSFER_NOT_ALLOWED',
      'Only sold property without a pending transfer can be transferred.',
    );
    found(await tx.customer.findFirst({ where: { id: input.buyerId, projectId: ctx.projectId } }));
    requireState(
      !booking.owners.some((o) => o.customerId === input.buyerId),
      'ALREADY_OWNER',
      'The buyer already owns the property.',
    );
    const ndc = found(
      await tx.ndc.findFirst({ where: { id: input.ndcId, bookingId: booking.id } }),
    );
    requireState(
      ndc.status === 'APPROVED' && ndc.expiresAt && ndc.expiresAt > new Date(),
      'INVALID_NDC',
      'An unexpired issued NDC is required.',
    );
    await settled(tx, booking.id);
    const transfer = await tx.transfer.create({
      data: { ...input, reference: await reference(tx, 'TRF'), requestedBy: ctx.actor.id },
    });
    await unitState(tx, ctx, unit.id, 'TRANSFER_PENDING', 'Transfer requested');
    const approval = await requestApproval(tx, ctx, 'TRANSFER', transfer.id, input.charges);
    return { transfer, approval };
  });
}
export async function transferFee(
  ctx: Context,
  id: string,
  input: { accountId: string; paymentReference: string },
) {
  return transaction(async (tx) => {
    const transfer = found(
      await tx.transfer.findFirst({
        where: { id, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    await scopedBooking(tx, ctx, transfer.bookingId);
    await lock(tx, 'Transfer', id);
    const current = found(await tx.transfer.findUnique({ where: { id } }));
    requireState(
      current.status === 'PENDING' && !current.paidAt,
      'TRANSFER_FEE_ALREADY_SETTLED',
      'Transfer fee is no longer pending.',
    );
    requireState(
      current.requestedBy !== ctx.actor.id,
      'SELF_VERIFICATION_FORBIDDEN',
      'A different user must verify the fee.',
      403,
    );
    const account = found(
      await tx.account.findFirst({
        where: { id: input.accountId, projectId: ctx.projectId, type: 'ASSET', active: true },
      }),
    );
    if (current.charges.gt(0))
      await postJournal(tx, ctx, {
        source: 'TRANSFER_FEE',
        sourceId: id,
        description: 'Verified transfer charges',
        lines: [
          { accountId: account.id, debit: current.charges, credit: 0 },
          {
            accountId: await mappedAccount(tx, ctx.projectId, 'transferRevenue'),
            debit: 0,
            credit: current.charges,
          },
        ],
      });
    const result = await tx.transfer.update({
      where: { id },
      data: { paidAt: new Date(), paymentReference: input.paymentReference },
    });
    await audit(tx, ctx, 'transfer.fee_verified', id);
    return result;
  });
}
export async function completeTransfer(ctx: Context, id: string, approvalId: string) {
  return transaction(async (tx) => {
    const transfer = found(
      await tx.transfer.findFirst({
        where: { id, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    const booking = await scopedBooking(tx, ctx, transfer.bookingId);
    await scopedUnit(tx, ctx, booking.unitId);
    await lock(tx, 'Transfer', id);
    const current = found(await tx.transfer.findUnique({ where: { id }, include: { ndc: true } }));
    requireState(
      current.status === 'PENDING' &&
        booking.status === 'CONFIRMED' &&
        booking.unit.status === 'TRANSFER_PENDING',
      'TRANSFER_CLOSED',
      'Transfer is no longer pending.',
    );
    requireState(
      current.charges.eq(0) || current.paidAt,
      'TRANSFER_FEE_REQUIRED',
      'Transfer charges must be verified.',
    );
    requireState(
      current.ndc.status === 'APPROVED' &&
        current.ndc.expiresAt &&
        current.ndc.expiresAt > new Date(),
      'INVALID_NDC',
      'The NDC expired or was already used.',
    );
    await settled(tx, booking.id);
    await consume(tx, ctx, approvalId, 'TRANSFER', id);
    const now = new Date();
    await tx.bookingOwner.updateMany({
      where: { bookingId: booking.id, validTo: null },
      data: { validTo: now },
    });
    await tx.bookingOwner.create({
      data: { bookingId: booking.id, customerId: current.buyerId, share: 100, validFrom: now },
    });
    await tx.booking.update({ where: { id: booking.id }, data: { customerId: current.buyerId } });
    await tx.ndc.updateMany({
      where: { bookingId: booking.id, status: 'APPROVED' },
      data: { status: 'COMPLETED' },
    });
    const result = await tx.transfer.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: now },
    });
    await unitState(tx, ctx, booking.unitId, 'SOLD', 'Ownership transferred');
    await audit(tx, ctx, 'transfer.completed', id);
    await outbox(tx, 'business-event', {
      projectId: ctx.projectId,
      kind: 'Ownership transferred',
      entityId: id,
    });
    return result;
  });
}
export async function cancelTransfer(ctx: Context, id: string) {
  return transaction(async (tx) => {
    const transfer = found(
      await tx.transfer.findFirst({
        where: { id, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    const booking = await scopedBooking(tx, ctx, transfer.bookingId);
    await scopedUnit(tx, ctx, booking.unitId);
    requireState(
      transfer.status === 'PENDING' && !transfer.paidAt,
      'TRANSFER_FEE_SETTLED',
      'Only unpaid pending transfers can be withdrawn.',
    );
    await tx.transfer.update({ where: { id }, data: { status: 'REJECTED' } });
    await tx.approval.updateMany({
      where: { entityId: id, operation: 'TRANSFER', status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'REJECTED' },
    });
    await unitState(tx, ctx, booking.unitId, 'SOLD', 'Transfer withdrawn');
    return { cancelled: true };
  });
}
export async function requestCancellation(
  ctx: Context,
  input: { bookingId: string; deduction: string; reason: string },
) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, input.bookingId);
    requireState(
      booking.status !== 'CANCELLED',
      'BOOKING_CANCELLED',
      'Booking is already cancelled.',
    );
    requireState(
      !['TRANSFER_PENDING', 'POSSESSED'].includes(booking.unit.status),
      'OWNERSHIP_CONFLICT',
      'Resolve transfers or possession before cancellation.',
    );
    const collected = await clearedTotal(tx, booking.id);
    requireState(
      decimal(input.deduction).lte(collected),
      'INVALID_DEDUCTION',
      'Deductions cannot exceed cleared collections.',
      422,
    );
    const cancellation = await tx.cancellation.create({
      data: { ...input, refundable: collected.minus(input.deduction), requestedBy: ctx.actor.id },
    });
    const approval = await requestApproval(
      tx,
      ctx,
      'CANCELLATION',
      cancellation.id,
      cancellation.refundable.toFixed(2),
    );
    return { cancellation, approval };
  });
}
export async function completeCancellation(ctx: Context, id: string, approvalId: string) {
  return transaction(async (tx) => {
    const cancellation = found(
      await tx.cancellation.findFirst({
        where: { id, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    const booking = await scopedBooking(tx, ctx, cancellation.bookingId);
    await scopedUnit(tx, ctx, booking.unitId);
    await lock(tx, 'Cancellation', id);
    const current = found(await tx.cancellation.findUnique({ where: { id } }));
    requireState(
      current.status === 'PENDING' &&
        booking.status !== 'CANCELLED' &&
        !['TRANSFER_PENDING', 'POSSESSED'].includes(booking.unit.status),
      'CANCELLATION_CONFLICT',
      'The current booking state does not permit cancellation.',
    );
    const collected = await clearedTotal(tx, booking.id);
    requireState(
      collected.minus(current.deduction).eq(current.refundable),
      'CANCELLATION_AMOUNT_CHANGED',
      'Collections changed; a new cancellation calculation is required.',
    );
    await consume(tx, ctx, approvalId, 'CANCELLATION', id);
    if (current.deduction.gt(0))
      await postJournal(tx, ctx, {
        source: 'CANCELLATION',
        sourceId: id,
        description: 'Approved cancellation deduction',
        lines: [
          {
            accountId: await mappedAccount(tx, ctx.projectId, 'advances'),
            debit: current.deduction,
            credit: 0,
          },
          {
            accountId: await mappedAccount(tx, ctx.projectId, 'deductions'),
            debit: 0,
            credit: current.deduction,
          },
        ],
      });
    const commission = await tx.dealerCommission.findUnique({ where: { bookingId: booking.id } });
    if (commission) {
      if (commission.status === 'COMPLETED')
        await postJournal(tx, ctx, {
          source: 'COMMISSION_CLAWBACK',
          sourceId: commission.id,
          description: 'Dealer commission recoverable after cancellation',
          lines: [
            {
              accountId: await mappedAccount(tx, ctx.projectId, 'dealerRecoverable'),
              debit: commission.amount,
              credit: 0,
            },
            {
              accountId: await mappedAccount(tx, ctx.projectId, 'commissionExpense'),
              debit: 0,
              credit: commission.amount,
            },
          ],
        });
      await tx.dealerCommission.update({
        where: { id: commission.id },
        data: { status: 'REJECTED' },
      });
    }
    await tx.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
    await tx.bookingOwner.updateMany({
      where: { bookingId: booking.id, validTo: null },
      data: { validTo: new Date() },
    });
    await tx.payment.updateMany({
      where: { bookingId: booking.id, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });
    await tx.ndc.updateMany({
      where: { bookingId: booking.id, status: { in: ['APPROVED', 'PENDING'] } },
      data: { status: 'REJECTED' },
    });
    await tx.possession.updateMany({
      where: { bookingId: booking.id, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });
    const result = await tx.cancellation.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await unitState(tx, ctx, booking.unitId, 'AVAILABLE', 'Booking cancelled');
    await audit(tx, ctx, 'cancellation.completed', id);
    await outbox(tx, 'business-event', {
      projectId: ctx.projectId,
      kind: 'Booking cancelled',
      entityId: id,
    });
    return result;
  });
}
export async function requestRefund(
  ctx: Context,
  input: { cancellationId: string; amount: string },
) {
  return transaction(async (tx) => {
    const c = found(
      await tx.cancellation.findFirst({
        where: { id: input.cancellationId, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    await lock(tx, 'Cancellation', c.id);
    requireState(
      c.status === 'COMPLETED',
      'CANCELLATION_REQUIRED',
      'Cancellation must be completed first.',
    );
    const reserved = await tx.refund.aggregate({
      where: { cancellationId: c.id, status: { in: ['PENDING', 'APPROVED', 'COMPLETED'] } },
      _sum: { amount: true },
    });
    requireState(
      (reserved._sum.amount ?? decimal(0)).plus(input.amount).lte(c.refundable),
      'REFUND_LIMIT',
      'Requested refunds exceed the refundable balance.',
    );
    const refund = await tx.refund.create({ data: { ...input, requestedBy: ctx.actor.id } });
    const approval = await requestApproval(tx, ctx, 'REFUND', refund.id, input.amount);
    return { refund, approval };
  });
}
export async function payRefund(
  ctx: Context,
  id: string,
  input: { approvalId: string; accountId: string; paymentReference: string },
) {
  return transaction(async (tx) => {
    const refund = found(
      await tx.refund.findFirst({
        where: { id, cancellation: { booking: { unit: { projectId: ctx.projectId } } } },
      }),
    );
    await lock(tx, 'Cancellation', refund.cancellationId);
    await lock(tx, 'Refund', id);
    const current = found(
      await tx.refund.findUnique({ where: { id }, include: { cancellation: true } }),
    );
    requireState(
      current.status === 'PENDING' && current.cancellation.status === 'COMPLETED',
      'REFUND_ALREADY_PAID',
      'This refund is not pending.',
    );
    const completed = await tx.refund.aggregate({
      where: { cancellationId: current.cancellationId, status: 'COMPLETED' },
      _sum: { amount: true },
    });
    requireState(
      (completed._sum.amount ?? decimal(0))
        .plus(current.amount)
        .lte(current.cancellation.refundable),
      'REFUND_LIMIT',
      'Refund would exceed the approved balance.',
    );
    await consume(tx, ctx, input.approvalId, 'REFUND', id);
    const account = found(
      await tx.account.findFirst({
        where: { id: input.accountId, projectId: ctx.projectId, type: 'ASSET', active: true },
      }),
    );
    await postJournal(tx, ctx, {
      source: 'REFUND',
      sourceId: id,
      description: 'Customer refund',
      lines: [
        {
          accountId: await mappedAccount(tx, ctx.projectId, 'advances'),
          debit: current.amount,
          credit: 0,
        },
        { accountId: account.id, debit: 0, credit: current.amount },
      ],
    });
    const result = await tx.refund.update({
      where: { id },
      data: { status: 'COMPLETED', paidAt: new Date(), paymentReference: input.paymentReference },
    });
    await audit(tx, ctx, 'refund.paid', id);
    await outbox(tx, 'business-event', {
      projectId: ctx.projectId,
      kind: 'Refund paid',
      entityId: id,
    });
    return result;
  });
}
export async function requestPossession(ctx: Context, bookingId: string) {
  return transaction(async (tx) => {
    const booking = await scopedBooking(tx, ctx, bookingId);
    requireState(
      booking.status === 'CONFIRMED' && booking.unit.status === 'SOLD',
      'POSSESSION_NOT_ELIGIBLE',
      'Only settled sold units are eligible.',
    );
    await settled(tx, booking.id);
    requireState(
      !(await tx.possession.findFirst({
        where: { bookingId, status: { in: ['PENDING', 'COMPLETED'] } },
      })),
      'POSSESSION_EXISTS',
      'A possession request already exists.',
    );
    const possession = await tx.possession.create({
      data: { bookingId, requestedBy: ctx.actor.id },
    });
    const approval = await requestApproval(tx, ctx, 'POSSESSION', possession.id, '0');
    return { possession, approval };
  });
}
export async function handover(ctx: Context, id: string, approvalId: string) {
  return transaction(async (tx) => {
    const possession = found(
      await tx.possession.findFirst({
        where: { id, booking: { unit: { projectId: ctx.projectId } } },
      }),
    );
    const booking = await scopedBooking(tx, ctx, possession.bookingId);
    await scopedUnit(tx, ctx, booking.unitId);
    await lock(tx, 'Possession', id);
    const current = found(
      await tx.possession.findUnique({ where: { id }, include: { snags: true } }),
    );
    requireState(
      current.status === 'PENDING' &&
        current.inspectionAt &&
        booking.status === 'CONFIRMED' &&
        booking.unit.status === 'SOLD',
      'INSPECTION_REQUIRED',
      'An inspected, eligible possession request is required.',
    );
    requireState(
      current.snags.every((s) => s.resolvedAt),
      'UNRESOLVED_SNAGS',
      'All snags must be resolved.',
    );
    await settled(tx, booking.id);
    await consume(tx, ctx, approvalId, 'POSSESSION', id);
    await unitState(tx, ctx, booking.unitId, 'POSSESSION_READY', 'Handover approved');
    const result = await tx.possession.update({
      where: { id },
      data: { status: 'COMPLETED', handoverAt: new Date() },
    });
    await unitState(tx, ctx, booking.unitId, 'POSSESSED', 'Handover completed');
    await audit(tx, ctx, 'possession.handover', id);
    await outbox(tx, 'business-event', {
      projectId: ctx.projectId,
      kind: 'Possession completed',
      entityId: id,
    });
    return result;
  });
}
export async function settleCommission(
  ctx: Context,
  id: string,
  input: { approvalId: string; accountId: string; paymentReference: string },
) {
  return transaction(async (tx) => {
    const commission = found(
      await tx.dealerCommission.findFirst({ where: { id, dealer: { projectId: ctx.projectId } } }),
    );
    const booking = await scopedBooking(tx, ctx, commission.bookingId);
    await lock(tx, 'DealerCommission', id);
    const current = found(await tx.dealerCommission.findUnique({ where: { id } }));
    requireState(
      current.status === 'PENDING' && booking.status === 'CONFIRMED',
      'COMMISSION_NOT_PAYABLE',
      'Commission is no longer payable.',
    );
    await consume(tx, ctx, input.approvalId, 'COMMISSION', id);
    const account = found(
      await tx.account.findFirst({
        where: { id: input.accountId, projectId: ctx.projectId, type: 'ASSET', active: true },
      }),
    );
    await postJournal(tx, ctx, {
      source: 'COMMISSION',
      sourceId: id,
      description: 'Approved dealer commission settlement',
      lines: [
        {
          accountId: await mappedAccount(tx, ctx.projectId, 'commissionExpense'),
          debit: current.amount,
          credit: 0,
        },
        { accountId: account.id, debit: 0, credit: current.amount },
      ],
    });
    const result = await tx.dealerCommission.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        settledAt: new Date(),
        paymentReference: input.paymentReference,
      },
    });
    await audit(tx, ctx, 'commission.settled', id);
    return result;
  });
}
export const refundTotal = (amounts: string[]) => sum(amounts);
