import { DateTime } from 'luxon';
import type { Tx } from '../../database/client.js';
import { found, requireState } from '../../common/errors.js';
import { financialPosition, projectDay } from '../portal/service.js';
import type { ReportQuery, ReportRow } from './service.js';
import {
  type AccountStatement,
  paymentColumns,
  statementStatus,
  statementMoney,
} from './statement-format.js';

export async function customerStatementReport(
  tx: Tx,
  projectId: string,
  q: ReportQuery,
  limit: number,
) {
  requireState(
    q.customerId,
    'CUSTOMER_REQUIRED',
    'Choose a customer to view their statement.',
    422,
  );
  const project = found(
    await tx.project.findUnique({
      where: { id: projectId },
      select: { name: true, currency: true, timezone: true },
    }),
  );
  const customer = found(
    await tx.customer.findFirst({
      where: { id: q.customerId, projectId },
      select: { name: true, reference: true, email: true, phone: true },
    }),
  );
  const unit = { projectId, phase: q.phase };
  const bookings = await tx.booking.findMany({
    where: { unit, id: q.bookingId, owners: { some: { customerId: q.customerId } } },
    select: {
      id: true,
      reference: true,
      total: true,
      status: true,
      createdAt: true,
      unit: { select: { number: true } },
      owners: { where: { customerId: q.customerId, validTo: null }, select: { id: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  const payments = await tx.payment.findMany({
    where: {
      booking: { unit, id: q.bookingId },
      payerId: q.customerId,
      status: { in: ['CLEARED', 'REVERSED'] },
      paidAt: {
        gte: q.from
          ? DateTime.fromISO(q.from, { zone: project.timezone }).startOf('day').toJSDate()
          : undefined,
        lt: q.to
          ? DateTime.fromISO(q.to, { zone: project.timezone })
              .plus({ days: 1 })
              .startOf('day')
              .toJSDate()
          : undefined,
      },
    },
    select: {
      amount: true,
      status: true,
      method: true,
      paidAt: true,
      receipt: { select: { reference: true } },
      booking: { select: { reference: true, unit: { select: { number: true } } } },
    },
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  requireState(
    bookings.length + payments.length <= limit,
    'REPORT_TOO_LARGE',
    'Use a background export or narrow the payment date range.',
    422,
  );
  const position = await financialPosition(
    {
      unit,
      id: q.bookingId,
      status: 'CONFIRMED',
      owners: { some: { customerId: q.customerId, validTo: null } },
    },
    projectDay(project.timezone),
    tx,
  );
  const statement: AccountStatement = {
    project,
    customer,
    generatedAt: new Date().toISOString(),
    from: q.from,
    to: q.to,
    metrics: [
      { label: 'Contract value', amount: position.total },
      { label: 'Verified payments', amount: position.paid },
      { label: 'Scheduled balance', amount: position.outstanding, emphasis: true },
    ],
    notes: [
      'Balances are current and cover complete confirmed bookings under current ownership, including joint ownership.',
      "Date filters apply to payment history only. Payment history lists this customer's verified and reversed payments; reversed payments do not reduce balances.",
      `Overdue installments: ${project.currency} ${statementMoney(position.overdue)}. Unallocated advance credit: ${project.currency} ${statementMoney(position.advanceCredit)}.`,
    ],
    sections: [
      {
        title: 'Booking overview',
        description:
          'Current and historical property bookings. Cancelled bookings and previous ownership are excluded from the balance summary.',
        columns: [
          { key: 'date', label: 'Booked on', type: 'date', width: 65 },
          { key: 'reference', label: 'Booking / property', width: 125 },
          { key: 'ownership', label: 'Ownership', width: 64 },
          { key: 'status', label: 'Status', type: 'status', width: 82 },
          { key: 'amount', label: 'Contract value', type: 'money', width: 110 },
        ],
        rows: bookings.map((b) => ({
          date: b.createdAt.toISOString(),
          reference: `${b.reference}\nProperty ${b.unit.number}`,
          ownership: b.owners.length ? 'Current' : 'Previous',
          status: b.status,
          amount: b.total.toFixed(2),
        })),
      },
      {
        title: 'Payment history',
        description: 'Payments recorded for this customer in the selected period.',
        columns: paymentColumns,
        rows: payments.map((p) => ({
          date: p.paidAt.toISOString(),
          reference: `${p.receipt?.reference ?? 'Receipt not issued'}\n${p.booking.reference} / ${p.booking.unit.number}`,
          method: statementStatus(p.method),
          status: p.status,
          amount: p.amount.toFixed(2),
        })),
      },
    ],
  };
  const rows: ReportRow[] = statement.sections.flatMap((section, index) =>
    section.rows.map((r) => ({ kind: index === 0 ? 'BOOKING' : 'PAYMENT', ...r })),
  );
  return {
    kind: q.kind,
    rows,
    count: rows.length,
    summary: {},
    currency: project.currency,
    statement,
  };
}
