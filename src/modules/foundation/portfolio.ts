import { Prisma } from '@prisma/client';
import { db } from '../../database/client.js';
import type { Context } from '../../common/context.js';

export const customerGroups = ['UNASSIGNED', 'INSTALLMENTS', 'FULLY_PAID', 'PENDING'] as const;
export type CustomerGroup = (typeof customerGroups)[number];

// Current ownership, not the original booking customer, determines the portfolio.
// Cancelled bookings and unverified/reversed payments must not affect these groups.
export async function customerDirectoryPage(
  ctx: Context,
  query: { search?: string; group?: CustomerGroup; page: number; limit: number; sort: string },
  identity?: string,
) {
  const search = query.search ? `%${query.search.replace(/[\\%_]/g, '\\$&')}%` : null;
  const direction = query.sort === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const [result] = await db.$queryRaw<
    {
      ids: string[];
      total: number;
      groups: Record<CustomerGroup | 'ALL', number>;
    }[]
  >(Prisma.sql`
    WITH candidates AS (
      SELECT c.id, c."createdAt" FROM "Customer" c
      WHERE c."projectId" = ${ctx.projectId}::uuid
        ${identity ? Prisma.sql`AND c."identityHash" = ${identity}` : Prisma.empty}
        ${
          search
            ? Prisma.sql`AND (c.name ILIKE ${search} OR c."fatherName" ILIKE ${search} OR c.phone ILIKE ${search}
          OR c.email ILIKE ${search} OR c.reference ILIKE ${search}
          OR ('MEM-' || left(c.id::text, 8)) ILIKE ${search}
          OR ('CUST-' || left(c.id::text, 8)) ILIKE ${search})`
            : Prisma.empty
        }
    ), current_bookings AS (
      SELECT b.id, b.status, b."paymentType", b.total, o."customerId",
        COALESCE((SELECT SUM(p.amount) FROM "Payment" p
          WHERE p."bookingId" = b.id AND p.status = 'CLEARED'), 0) AS paid
      FROM "BookingOwner" o JOIN candidates c ON c.id = o."customerId"
      JOIN "Booking" b ON b.id = o."bookingId"
      JOIN "Unit" u ON u.id = b."unitId"
      WHERE o."validTo" IS NULL AND b.status <> 'CANCELLED'
        AND u."projectId" = ${ctx.projectId}::uuid
    ), classified AS (
      SELECT c.id, c."createdAt", CASE
        WHEN COUNT(b.id) = 0 THEN 'UNASSIGNED'
        WHEN BOOL_AND(b.status = 'CONFIRMED' AND b.paid >= b.total) THEN 'FULLY_PAID'
        WHEN BOOL_OR(b.status = 'CONFIRMED' AND b."paymentType" = 'INSTALLMENTS' AND b.paid < b.total)
          THEN 'INSTALLMENTS'
        ELSE 'PENDING' END AS category
      FROM candidates c LEFT JOIN current_bookings b ON b."customerId" = c.id
      GROUP BY c.id, c."createdAt"
    ), filtered AS (
      SELECT * FROM classified ${query.group ? Prisma.sql`WHERE category = ${query.group}` : Prisma.empty}
    ), page AS (
      SELECT id, "createdAt" FROM filtered ORDER BY "createdAt" ${direction}, id
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    )
    SELECT COALESCE((SELECT ARRAY_AGG(id::text ORDER BY "createdAt" ${direction}, id) FROM page), ARRAY[]::text[]) AS ids,
      (SELECT COUNT(*)::int FROM filtered) AS total,
      (SELECT JSON_BUILD_OBJECT(
        'ALL', COUNT(*)::int,
        'UNASSIGNED', COUNT(*) FILTER (WHERE category = 'UNASSIGNED')::int,
        'INSTALLMENTS', COUNT(*) FILTER (WHERE category = 'INSTALLMENTS')::int,
        'FULLY_PAID', COUNT(*) FILTER (WHERE category = 'FULLY_PAID')::int,
        'PENDING', COUNT(*) FILTER (WHERE category = 'PENDING')::int
      ) FROM classified) AS groups
  `);
  return result!;
}

export async function portfolioBookings(ctx: Context, where: Prisma.BookingWhereInput) {
  if (!ctx.actor.permissions.has('bookings.read')) return [];
  const bookings = await db.booking.findMany({
    where: { AND: [where, { status: { not: 'CANCELLED' }, unit: { projectId: ctx.projectId } }] },
    select: {
      id: true,
      reference: true,
      status: true,
      paymentType: true,
      total: true,
      unit: { select: { id: true, number: true } },
      owners: {
        where: { validTo: null, customer: { projectId: ctx.projectId } },
        select: { customer: { select: { id: true, name: true } } },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  const payments = bookings.length
    ? await db.payment.groupBy({
        by: ['bookingId'],
        where: { bookingId: { in: bookings.map((b) => b.id) }, status: 'CLEARED' },
        _sum: { amount: true },
      })
    : [];
  const paid = new Map(payments.map((p) => [p.bookingId, p._sum.amount ?? new Prisma.Decimal(0)]));
  return bookings.map(({ owners, ...booking }) => {
    const collected = paid.get(booking.id) ?? new Prisma.Decimal(0);
    return {
      ...booking,
      customers: owners.map((o) => o.customer),
      collected: collected.toFixed(2),
      outstanding: Prisma.Decimal.max(0, booking.total.minus(collected)).toFixed(2),
      paymentStatus:
        booking.status === 'CONFIRMED' && collected.gte(booking.total)
          ? 'FULLY_PAID'
          : booking.status === 'CONFIRMED' && booking.paymentType === 'INSTALLMENTS'
            ? 'INSTALLMENTS'
            : 'PENDING',
    };
  });
}

export function customerPaymentStatus(
  bookings: Awaited<ReturnType<typeof portfolioBookings>>,
): CustomerGroup {
  if (!bookings.length) return 'UNASSIGNED';
  if (bookings.every((b) => b.paymentStatus === 'FULLY_PAID')) return 'FULLY_PAID';
  if (bookings.some((b) => b.paymentStatus === 'INSTALLMENTS')) return 'INSTALLMENTS';
  return 'PENDING';
}

export async function withUnitPortfolio<T extends { id: string }>(ctx: Context, units: T[]) {
  if (!ctx.actor.permissions.has('bookings.read')) return units;
  const bookings = await portfolioBookings(ctx, { unitId: { in: units.map((u) => u.id) } });
  return units.map((unit) => ({
    ...unit,
    bookings: bookings
      .filter((b) => b.unit.id === unit.id)
      .map((b) => ({
        ...b,
        customers: ctx.actor.permissions.has('customers.read') ? b.customers : undefined,
      })),
  }));
}

export async function withCustomerPortfolio<T extends { id: string }>(
  ctx: Context,
  customers: T[],
) {
  if (!ctx.actor.permissions.has('bookings.read')) return customers;
  const bookings = await portfolioBookings(ctx, {
    owners: { some: { customerId: { in: customers.map((c) => c.id) }, validTo: null } },
  });
  return customers.map((customer) => {
    const current = bookings.filter((b) => b.customers.some((c) => c.id === customer.id));
    return {
      ...customer,
      paymentStatus: customerPaymentStatus(current),
      bookings: current.map(({ customers: _customers, ...booking }) => ({
        ...booking,
        unit: ctx.actor.permissions.has('inventory.read') ? booking.unit : undefined,
      })),
    };
  });
}
