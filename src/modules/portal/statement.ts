import { randomUUID } from 'node:crypto';
import { db } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { throttle } from '../../integrations/redis.js';
import { putObject, signedDownload } from '../../integrations/storage.js';
import { pdfBuffer } from '../../jobs/artifacts.js';
import { ownBooking, financialPosition, projectDay, installmentAmounts } from './service.js';
import { ownedBookings } from './access.js';

export async function customerStatement(ctx: Context, bookingId: string) {
  const booking = await ownBooking(ctx.actor.id, bookingId);
  requireState(
    await throttle(`portal-statement:${ctx.actor.id}`, 5, 300),
    'EXPORT_THROTTLED',
    'Please wait before requesting another statement.',
    429,
  );
  const [position, schedule, payments] = await Promise.all([
    financialPosition(
      { AND: [{ id: bookingId }, ownedBookings(ctx.actor.id)] },
      projectDay(booking.unit.project.timezone),
    ),
    db.installment.findMany({
      where: { bookingId, booking: ownedBookings(ctx.actor.id), superseded: false },
      orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
      take: 5001,
      select: {
        label: true,
        dueDate: true,
        amount: true,
        allocations: { where: { reversedAt: null }, select: { amount: true } },
      },
    }),
    db.payment.findMany({
      where: {
        bookingId,
        booking: ownedBookings(ctx.actor.id),
        payer: { portalUserId: ctx.actor.id },
      },
      orderBy: { paidAt: 'asc' },
      take: 5001,
      select: {
        amount: true,
        status: true,
        method: true,
        paidAt: true,
        receipt: { select: { reference: true, reversedAt: true } },
      },
    }),
  ]);
  requireState(
    schedule.length <= 5000 && payments.length <= 5000,
    'STATEMENT_TOO_LARGE',
    'Contact the property office for an extended account statement.',
    422,
  );
  const lines = [
    booking.unit.project.name,
    `Unit: ${booking.unit.number}`,
    `Booking: ${booking.reference} (${booking.status})`,
    `Currency: ${booking.unit.project.currency}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'BOOKING POSITION (whole booking, including joint ownership)',
    `Contract value: ${position.total}`,
    `Cleared payments: ${position.paid}`,
    `Scheduled balance: ${position.outstanding}`,
    `Overdue installments: ${position.overdue}`,
    `Unallocated advance credit: ${position.advanceCredit}`,
    '',
    booking.status === 'CANCELLED'
      ? 'Cancelled booking: amounts are historical, not a payment demand. Contact the office for cancellation/refund details.'
      : 'Only cleared payments reduce balances. Contact the office for any corrections.',
    '',
    'CURRENT INSTALLMENT SCHEDULE',
    ...schedule.map((i) => {
      const p = installmentAmounts(i);
      return `${i.dueDate.toISOString().slice(0, 10)} | ${i.label} | Scheduled ${p.amount} | Paid ${p.paid} | Balance ${p.outstanding}`;
    }),
    '',
    'YOUR RECORDED PAYMENTS (linked customer profiles only)',
    ...payments.map(
      (p) =>
        `${p.paidAt.toISOString().slice(0, 10)} | ${p.amount.toFixed(2)} | ${p.method} | ${p.status} | Receipt ${p.receipt?.reference ?? 'not issued'}${p.receipt?.reversedAt ? ' (reversed)' : ''}`,
    ),
  ];
  const pdf = await pdfBuffer('Customer account statement', lines.join('\n'));
  await ownBooking(ctx.actor.id, bookingId);
  const key = `portal-statements/${ctx.actor.id}/${randomUUID()}.pdf`;
  await putObject(key, pdf, 'application/pdf');
  await audit(
    db,
    { ...ctx, projectId: booking.unit.project.id },
    'customer.statement_downloaded',
    bookingId,
  );
  return { url: await signedDownload(key), expiresIn: 120 };
}
