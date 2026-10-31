import type { Express } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { transaction } from '../../database/client.js';
import { endpoint, paginationQuery, paged } from '../../common/http.js';
import { found } from '../../common/errors.js';
import { sum } from '../../common/money.js';

const root = '/projects/:projectId/installment-calendar';
export function calendarRoutes(app: Express) {
  endpoint(
    app,
    'get',
    root,
    {
      permission: 'reports.read',
      summary: 'Aggregate every installment in a calendar month without a row cap',
      query: z
        .object({ from: z.iso.date(), to: z.iso.date() })
        .strict()
        .refine(
          (q) => q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 62 * 86400000,
          'Choose a range of at most 63 days.',
        ),
    },
    async (ctx, _body, q) =>
      transaction(async (tx) => {
        const project = found(
          await tx.project.findUnique({ where: { id: ctx.projectId }, select: { timezone: true } }),
        );
        const today = DateTime.now().setZone(project.timezone).toISODate()!;
        const days = await tx.$queryRaw<
          {
            date: string;
            total: number;
            overdue: number;
            unpaid: number;
            paid: number;
            outstanding: string;
          }[]
        >`
      WITH obligations AS (
        SELECT i."dueDate", i.amount - COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a
          WHERE a."installmentId" = i.id AND a."reversedAt" IS NULL), 0) AS balance
        FROM "Installment" i JOIN "Booking" b ON b.id = i."bookingId" JOIN "Unit" u ON u.id = b."unitId"
        WHERE u."projectId" = ${ctx.projectId}::uuid AND b.status <> 'CANCELLED' AND NOT i.superseded
          AND i."dueDate" BETWEEN ${q.from}::date AND ${q.to}::date
      )
      SELECT to_char("dueDate", 'YYYY-MM-DD') AS date, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE balance > 0 AND "dueDate" < ${today}::date)::int AS overdue,
        COUNT(*) FILTER (WHERE balance > 0 AND "dueDate" >= ${today}::date)::int AS unpaid,
        COUNT(*) FILTER (WHERE balance = 0)::int AS paid, SUM(balance)::text AS outstanding
      FROM obligations GROUP BY "dueDate" ORDER BY "dueDate"`;
        return { days, today };
      }),
  );
  endpoint(
    app,
    'get',
    root + '/day',
    {
      permission: 'reports.read',
      summary: 'Browse a complete day of installment obligations',
      query: paginationQuery.extend({
        date: z.iso.date(),
        status: z.enum(['all', 'unpaid', 'overdue', 'paid']).default('all'),
      }),
    },
    async (ctx, _body, q) =>
      transaction(async (tx) => {
        const project = found(
          await tx.project.findUnique({ where: { id: ctx.projectId }, select: { timezone: true } }),
        );
        const today = DateTime.now().setZone(project.timezone).toISODate()!;
        const direction = q.sort === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
        const [index] = await tx.$queryRaw<{ ids: string[]; total: number }[]>(Prisma.sql`
      WITH obligations AS (
        SELECT i.id, i.sequence, i.amount - COALESCE((SELECT SUM(a.amount) FROM "PaymentAllocation" a
          WHERE a."installmentId" = i.id AND a."reversedAt" IS NULL), 0) AS balance
        FROM "Installment" i JOIN "Booking" b ON b.id = i."bookingId" JOIN "Unit" u ON u.id = b."unitId"
        WHERE u."projectId" = ${ctx.projectId}::uuid AND b.status <> 'CANCELLED' AND NOT i.superseded AND i."dueDate" = ${q.date}::date
      ), filtered AS (
        SELECT * FROM obligations WHERE ${q.status} = 'all'
          OR (${q.status} = 'paid' AND balance = 0)
          OR (${q.status} = 'unpaid' AND balance > 0)
          OR (${q.status} = 'overdue' AND balance > 0 AND ${q.date}::date < ${today}::date)
      ), page AS (SELECT * FROM filtered ORDER BY sequence ${direction}, id ${direction} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit})
      SELECT COALESCE((SELECT ARRAY_AGG(id::text ORDER BY sequence ${direction}, id ${direction}) FROM page), ARRAY[]::text[]) AS ids,
        (SELECT COUNT(*)::int FROM filtered) AS total`);
        const records = await tx.installment.findMany({
          where: { id: { in: index!.ids } },
          include: {
            allocations: { where: { reversedAt: null } },
            booking: {
              select: {
                reference: true,
                customer: { select: { name: true, phone: true } },
                unit: { select: { number: true } },
              },
            },
          },
        });
        const byId = new Map(records.map((r) => [r.id, r]));
        const items = index!.ids.map((id) => byId.get(id)!);
        return paged(
          items.map((i) => {
            const paid = sum(i.allocations.map((a) => a.amount));
            const outstanding = i.amount.minus(paid).toFixed(2);
            return {
              id: i.id,
              bookingId: i.bookingId,
              reference: i.booking.reference,
              customerName: i.booking.customer.name,
              customerPhone: i.booking.customer.phone,
              unitNumber: i.booking.unit.number,
              label: i.label,
              dueDate: q.date,
              amount: i.amount.toFixed(2),
              paid: paid.toFixed(2),
              outstanding,
              overdue: q.date < today ? outstanding : '0.00',
            };
          }),
          index!.total,
          q,
        );
      }),
  );
}
