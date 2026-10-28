import { randomUUID } from 'node:crypto';
import { db } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { throttle } from '../../integrations/redis.js';
import { putObject, signedDownload } from '../../integrations/storage.js';
import { statementPdf } from '../../jobs/statement-pdf.js';
import { projectBranding } from '../../jobs/project-branding.js';
import {
  type AccountStatement,
  paymentColumns,
  statementStatus,
  statementMoney,
} from '../reports/statement-format.js';
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
  const profiles = await db.customer.findMany({
    where: { portalUserId: ctx.actor.id, projectId: booking.unit.project.id },
    select: { name: true, reference: true, email: true, phone: true },
    orderBy: { createdAt: 'asc' },
  });
  const statement: AccountStatement = {
    project: booking.unit.project,
    customer: {
      name: profiles.map((p) => p.name).join(' / '),
      reference: profiles.map((p) => p.reference).join(' / '),
      email: profiles[0]?.email,
      phone: profiles[0]?.phone,
    },
    reference: `${booking.reference} | Property ${booking.unit.number}\n${statementStatus(booking.status)}`,
    generatedAt: new Date().toISOString(),
    metrics: [
      { label: 'Contract value', amount: position.total },
      { label: 'Verified payments', amount: position.paid },
      { label: 'Scheduled balance', amount: position.outstanding, emphasis: true },
    ],
    notes: [
      'Balances cover the whole booking, including joint ownership. The payment history below shows only payments made through your linked customer profiles.',
      booking.status === 'CANCELLED'
        ? 'CANCELLED BOOKING: These amounts are historical, not a payment demand. Contact the office for cancellation or refund details.'
        : 'Only verified payments reduce balances. Pending, rejected, bounced and reversed payments do not reduce the amount due.',
      `Overdue installments: ${booking.unit.project.currency} ${statementMoney(position.overdue)}. Unallocated advance credit: ${booking.unit.project.currency} ${statementMoney(position.advanceCredit)}.`,
    ],
    sections: [
      {
        title: 'Installment schedule',
        description: 'Your current schedule, including verified allocations against each payment.',
        columns: [
          { key: 'date', label: 'Due date', type: 'date', width: 68 },
          { key: 'label', label: 'Installment', width: 104 },
          { key: 'amount', label: 'Scheduled', type: 'money', width: 98 },
          { key: 'paid', label: 'Paid', type: 'money', width: 88 },
          { key: 'outstanding', label: 'Balance', type: 'money', width: 98 },
        ],
        rows: schedule.map((i) => {
          const amounts = installmentAmounts(i);
          return {
            date: i.dueDate.toISOString().slice(0, 10),
            label: i.label,
            amount: amounts.amount,
            paid: amounts.paid,
            outstanding: amounts.outstanding,
          };
        }),
      },
      {
        title: 'Your payment history',
        description:
          'Your recorded payments and receipt references. Status indicates whether a payment has been verified.',
        columns: paymentColumns,
        rows: payments.map((p) => ({
          date: p.paidAt.toISOString(),
          amount: p.amount.toFixed(2),
          method: statementStatus(p.method),
          status: p.status,
          reference: `${p.receipt?.reference ?? 'Receipt not issued'}${p.receipt?.reversedAt ? ' (reversed)' : ''}\n${booking.reference}`,
        })),
      },
    ],
  };
  const pdf = await statementPdf(statement, await projectBranding(booking.unit.project.id));
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
