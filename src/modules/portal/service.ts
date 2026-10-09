import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { db } from '../../database/client.js';
import { found } from '../../common/errors.js';
import { decimal, sum } from '../../common/money.js';
import { ownedBookings } from './access.js';

export const projectSelect = {
  id: true,
  name: true,
  currency: true,
  timezone: true,
} satisfies Prisma.ProjectSelect;
export const bookingSelect = {
  id: true,
  reference: true,
  status: true,
  total: true,
  downPayment: true,
  createdAt: true,
  confirmedAt: true,
  unit: {
    select: {
      number: true,
      type: true,
      phase: true,
      block: true,
      floor: true,
      size: true,
      measurementUnit: true,
      status: true,
      project: { select: projectSelect },
    },
  },
} satisfies Prisma.BookingSelect;
export const documentSelect = {
  id: true,
  name: true,
  mime: true,
  size: true,
  createdAt: true,
  bookingId: true,
  project: { select: projectSelect },
} satisfies Prisma.DocumentSelect;

export async function financialPosition(where: Prisma.BookingWhereInput, today: Date) {
  const installments = { booking: where, superseded: false };
  const overdue = { ...installments, dueDate: { lt: today } };
  const [bookings, payments, scheduled, allocated, due, duePaid] = await Promise.all([
    db.booking.aggregate({ where, _sum: { total: true }, _count: true }),
    db.payment.aggregate({ where: { booking: where, status: 'CLEARED' }, _sum: { amount: true } }),
    db.installment.aggregate({ where: installments, _sum: { amount: true } }),
    db.paymentAllocation.aggregate({
      where: { installment: installments, reversedAt: null },
      _sum: { amount: true },
    }),
    db.installment.aggregate({ where: overdue, _sum: { amount: true } }),
    db.paymentAllocation.aggregate({
      where: { installment: overdue, reversedAt: null },
      _sum: { amount: true },
    }),
  ]);
  const paid = decimal(payments._sum.amount ?? 0);
  const allocation = decimal(allocated._sum.amount ?? 0);
  return {
    bookings: bookings._count,
    total: decimal(bookings._sum.total ?? 0).toFixed(2),
    paid: paid.toFixed(2),
    outstanding: Prisma.Decimal.max(
      0,
      decimal(scheduled._sum.amount ?? 0).minus(allocation),
    ).toFixed(2),
    overdue: Prisma.Decimal.max(
      0,
      decimal(due._sum.amount ?? 0).minus(duePaid._sum.amount ?? 0),
    ).toFixed(2),
    advanceCredit: Prisma.Decimal.max(0, paid.minus(allocation)).toFixed(2),
  };
}
export function projectDay(timezone: string) {
  return new Date(DateTime.now().setZone(timezone).toISODate()! + 'T00:00:00Z');
}
export async function dashboard(userId: string) {
  const projects = await db.project.findMany({
    where: { customers: { some: { portalUserId: userId } } },
    select: projectSelect,
  });
  const accounts = [];
  // Process one project at a time to avoid exhausting the database connection pool.
  for (const project of projects) {
    const position = await financialPosition(
      { AND: [ownedBookings(userId), { status: 'CONFIRMED', unit: { projectId: project.id } }] },
      projectDay(project.timezone),
    );
    accounts.push({ project, ...position });
  }
  // Allocation sums are evaluated in SQL, so fully paid rows never hide the next unpaid installment.
  const upcoming = await db.$queryRaw<
    Array<{
      id: string;
      reference: string;
      bookingId: string;
      label: string;
      dueDate: Date;
      outstanding: string;
      currency: string;
      projectName: string;
    }>
  >(Prisma.sql`
    SELECT i.id, b.reference, b.id AS "bookingId", i.label, i."dueDate",
      (i.amount - COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a WHERE a."installmentId"=i.id AND a."reversedAt" IS NULL),0))::text AS outstanding,
      p.currency, p.name AS "projectName"
    FROM "Installment" i JOIN "Booking" b ON b.id=i."bookingId"
      JOIN "Customer" c ON c.id=b."customerId" JOIN "Unit" u ON u.id=b."unitId" JOIN "Project" p ON p.id=u."projectId"
    WHERE NOT i.superseded AND b.status='CONFIRMED'
      AND (c."portalUserId"=${userId}::uuid OR EXISTS (
        SELECT 1 FROM "BookingOwner" o JOIN "Customer" co ON co.id=o."customerId"
        WHERE o."bookingId"=b.id AND o."validTo" IS NULL AND co."portalUserId"=${userId}::uuid))
      AND i.amount > COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a WHERE a."installmentId"=i.id AND a."reversedAt" IS NULL),0)
    ORDER BY i."dueDate", i.id LIMIT 5`);
  return { accounts, upcoming, asOf: new Date().toISOString() };
}
export async function ownBooking(userId: string, id: string) {
  return found(
    await db.booking.findFirst({
      where: { AND: [{ id }, ownedBookings(userId)] },
      select: bookingSelect,
    }),
  );
}
export function installmentAmounts<
  T extends { amount: Prisma.Decimal; allocations: { amount: Prisma.Decimal }[] },
>(item: T) {
  const { allocations, ...safe } = item;
  const paid = sum(allocations.map((a) => a.amount));
  return {
    ...safe,
    amount: item.amount.toFixed(2),
    paid: paid.toFixed(2),
    outstanding: Prisma.Decimal.max(0, item.amount.minus(paid)).toFixed(2),
  };
}
