import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db, transaction, type Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { decimal, sum } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { json, outbox, audit } from '../../common/operations.js';
import { redis } from '../../integrations/redis.js';
import { customerStatementReport } from './customer-statement.js';
export const reportKinds = [
  'sales',
  'inventory',
  'collections',
  'installments',
  'outstanding',
  'ageing',
  'customer-statement',
  'cancellations',
  'refunds',
  'ndcs',
  'transfers',
  'possession',
  'ledger',
  'vendor-ledger',
  'cash-book',
  'bank-book',
  'trial-balance',
  'income-statement',
  'balance-sheet',
] as const;
export const reportQuery = z
  .object({
    kind: z.enum(reportKinds),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    phase: z.string().max(100).optional(),
    customerId: z.uuid().optional(),
    bookingId: z.uuid().optional(),
    accountId: z.uuid().optional(),
    vendorId: z.uuid().optional(),
    assignedTo: z.uuid().optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'Invalid date range');
export type ReportQuery = z.infer<typeof reportQuery>;
export type ReportRow = Record<string, string | number | boolean | null>;
function flat(record: Record<string, unknown>): ReportRow {
  const result: ReportRow = {};
  for (const [k, v] of Object.entries(record)) {
    if (v instanceof Date) result[k] = v.toISOString();
    else if (v instanceof Prisma.Decimal) result[k] = v.toFixed(2);
    else if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      result[k] = v;
  }
  return result;
}
function range(q: ReportQuery, zone: string) {
  return {
    gte: q.from ? DateTime.fromISO(q.from, { zone }).startOf('day').toJSDate() : undefined,
    lt: q.to
      ? DateTime.fromISO(q.to, { zone }).plus({ days: 1 }).startOf('day').toJSDate()
      : undefined,
  };
}
async function queryReport(
  tx: Tx,
  projectId: string,
  q: ReportQuery,
  limit: number,
): Promise<ReportRow[]> {
  const project = found(await tx.project.findUnique({ where: { id: projectId } }));
  const dates = range(q, project.timezone);
  const unit = { projectId, phase: q.phase };
  const bookingWhere: Prisma.BookingWhereInput = {
    unit,
    id: q.bookingId,
    ...(q.customerId ? { owners: { some: { customerId: q.customerId } } } : {}),
    ...(q.assignedTo ? { recovery: { some: { assignedTo: q.assignedTo } } } : {}),
  };
  const take = limit + 1;
  let ledgerAccounts: string[] | undefined;
  if (q.kind === 'cash-book') {
    const mapping = found(
      await tx.projectSetting.findUnique({
        where: { projectId_key: { projectId, key: 'accounting' } },
      }),
    ).value as Record<string, string>;
    ledgerAccounts = [found(mapping.cash)];
  }
  if (q.kind === 'bank-book')
    ledgerAccounts = (
      await tx.bankAccount.findMany({
        where: { projectId, ...(q.accountId ? { accountId: q.accountId } : {}) },
      })
    ).map((b) => b.accountId);
  if (q.kind === 'vendor-ledger') {
    requireState(q.vendorId, 'VENDOR_REQUIRED', 'Vendor ledger requires vendorId.', 422);
    found(await tx.vendor.findFirst({ where: { id: q.vendorId, projectId } }));
  }
  switch (q.kind) {
    case 'inventory':
      return (await tx.unit.findMany({ where: unit, take, orderBy: { number: 'asc' } })).map(flat);
    case 'sales':
      return (
        await tx.booking.findMany({
          where: { ...bookingWhere, createdAt: dates },
          take,
          orderBy: { createdAt: 'desc' },
        })
      ).map(flat);
    case 'collections':
      return (
        await tx.payment.findMany({
          where: { booking: bookingWhere, paidAt: dates, status: 'CLEARED' },
          take,
          orderBy: { paidAt: 'desc' },
        })
      ).map(flat);
    case 'customer-statement':
      return (await customerStatementReport(tx, projectId, q, limit)).rows;
    case 'installments':
    case 'outstanding':
    case 'ageing': {
      const rows = await tx.installment.findMany({
        where: {
          booking: { ...bookingWhere, status: { not: 'CANCELLED' } },
          superseded: false,
          dueDate: {
            gte: q.from ? new Date(q.from) : undefined,
            lte: q.to ? new Date(q.to) : undefined,
          },
        },
        include: {
          allocations: { where: { reversedAt: null } },
          booking: { select: { reference: true, customerId: true } },
        },
        take,
        orderBy: { dueDate: 'asc' },
      });
      requireState(
        rows.length <= limit,
        'REPORT_TOO_LARGE',
        'Narrow the filters or use an export to avoid truncated report data.',
        422,
      );
      const today = DateTime.now().setZone(project.timezone).toISODate()!;
      const now = new Date(today).getTime();
      const settings = await tx.projectSetting.findUnique({
        where: { projectId_key: { projectId, key: 'ageingBuckets' } },
      });
      const boundaries = z
        .array(z.number().int().positive())
        .min(1)
        .max(10)
        .parse(settings?.value ?? [30, 60, 90]);
      return rows
        .map((r) => {
          const paid = sum(r.allocations.map((a) => a.amount));
          const due = r.amount.minus(paid);
          const lateDays = Math.max(0, Math.floor((now - r.dueDate.getTime()) / 86400000));
          const bucket =
            lateDays === 0
              ? 'CURRENT'
              : (boundaries.find((b) => lateDays <= b)?.toString() ?? `${boundaries.at(-1)}+`);
          return {
            id: r.id,
            bookingId: r.bookingId,
            reference: r.booking.reference,
            customerId: r.booking.customerId,
            dueDate: r.dueDate.toISOString().slice(0, 10),
            amount: r.amount.toFixed(2),
            paid: paid.toFixed(2),
            outstanding: due.toFixed(2),
            overdue: lateDays > 0 ? due.toFixed(2) : '0.00',
            lateDays,
            bucket,
          };
        })
        .filter(
          (r) =>
            q.kind === 'installments' ||
            (decimal(r.outstanding).gt(0) && (q.kind !== 'ageing' || r.lateDays > 0)),
        );
    }
    case 'cancellations':
      return (await tx.cancellation.findMany({ where: { booking: bookingWhere }, take })).map(flat);
    case 'refunds':
      return (
        await tx.refund.findMany({
          where: { cancellation: { booking: bookingWhere } },
          include: {
            cancellation: {
              select: {
                booking: { select: { reference: true, customer: { select: { name: true } } } },
              },
            },
          },
          take,
        })
      ).map((r) => ({
        ...flat(r),
        bookingReference: r.cancellation.booking.reference,
        customerName: r.cancellation.booking.customer.name,
      }));
    case 'ndcs':
      return (await tx.ndc.findMany({ where: { booking: bookingWhere }, take })).map(flat);
    case 'transfers':
      return (await tx.transfer.findMany({ where: { booking: bookingWhere }, take })).map(flat);
    case 'possession':
      return (await tx.possession.findMany({ where: { booking: bookingWhere }, take })).map(flat);
    case 'vendor-ledger':
    case 'cash-book':
    case 'bank-book':
    case 'ledger':
      return (
        await tx.journalLine.findMany({
          where: {
            journal: { projectId, postedAt: dates },
            accountId: ledgerAccounts ? { in: ledgerAccounts } : q.accountId,
            vendorId: q.vendorId,
          },
          include: {
            journal: {
              select: { reference: true, postedAt: true, source: true, description: true },
            },
            account: { select: { code: true, name: true } },
          },
          take,
          orderBy: { journal: { postedAt: 'asc' } },
        })
      ).map((r) => ({
        ...flat(r),
        reference: r.journal.reference,
        date: r.journal.postedAt.toISOString(),
        description: r.journal.description,
        accountCode: r.account.code,
        accountName: r.account.name,
      }));
    case 'trial-balance':
    case 'income-statement':
    case 'balance-sheet': {
      const where: Prisma.JournalLineWhereInput = {
        journal: { projectId, postedAt: q.kind === 'balance-sheet' ? { lt: dates.lt } : dates },
      };
      const balances = await tx.journalLine.groupBy({
        by: ['accountId'],
        where,
        _sum: { debit: true, credit: true },
      });
      const accounts = await tx.account.findMany({
        where: { projectId },
        orderBy: { code: 'asc' },
      });
      const rows = accounts
        .filter(
          (a) =>
            q.kind === 'trial-balance' ||
            (q.kind === 'income-statement' ? ['REVENUE', 'EXPENSE'].includes(a.type) : true),
        )
        .map((a) => {
          const balance = balances.find((b) => b.accountId === a.id);
          const debit = balance?._sum.debit ?? decimal(0);
          const credit = balance?._sum.credit ?? decimal(0);
          return {
            accountId: a.id,
            code: a.code,
            name: a.name,
            type: a.type,
            debit: debit.toFixed(2),
            credit: credit.toFixed(2),
            balance: (['ASSET', 'EXPENSE'].includes(a.type)
              ? debit.minus(credit)
              : credit.minus(debit)
            ).toFixed(2),
          };
        });
      if (q.kind === 'balance-sheet') {
        const earnings = sum(rows.filter((r) => r.type === 'REVENUE').map((r) => r.balance)).minus(
          sum(rows.filter((r) => r.type === 'EXPENSE').map((r) => r.balance)),
        );
        return [
          ...rows.filter((r) => ['ASSET', 'LIABILITY', 'EQUITY'].includes(r.type)),
          {
            accountId: '',
            code: 'CURRENT_EARNINGS',
            name: 'Current unclosed earnings',
            type: 'EQUITY',
            debit: Prisma.Decimal.max(earnings.negated(), 0).toFixed(2),
            credit: Prisma.Decimal.max(earnings, 0).toFixed(2),
            balance: earnings.toFixed(2),
          },
        ];
      }
      return rows;
    }
  }
}
export async function report(projectId: string, q: ReportQuery, limit = 1000) {
  if (q.kind === 'customer-statement')
    return transaction((tx) => customerStatementReport(tx, projectId, q, limit));
  const rows = await transaction((tx) => queryReport(tx, projectId, q, limit));
  requireState(
    rows.length <= limit,
    'REPORT_TOO_LARGE',
    'Use a background export for this report.',
    422,
  );
  const summary: Record<string, string | boolean> = {};
  if (q.kind === 'trial-balance') {
    const debit = sum(rows.map((r) => String(r.debit)));
    const credit = sum(rows.map((r) => String(r.credit)));
    Object.assign(summary, {
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      balanced: debit.eq(credit),
    });
  }
  if (q.kind === 'income-statement') {
    const revenue = sum(rows.filter((r) => r.type === 'REVENUE').map((r) => String(r.balance)));
    const expense = sum(rows.filter((r) => r.type === 'EXPENSE').map((r) => String(r.balance)));
    Object.assign(summary, {
      revenue: revenue.toFixed(2),
      expense: expense.toFixed(2),
      netIncome: revenue.minus(expense).toFixed(2),
    });
  }
  if (q.kind === 'balance-sheet') {
    const total = (type: string) =>
      sum(rows.filter((r) => r.type === type).map((r) => String(r.balance)));
    const assets = total('ASSET'),
      liabilities = total('LIABILITY'),
      equity = total('EQUITY');
    Object.assign(summary, {
      assets: assets.toFixed(2),
      liabilities: liabilities.toFixed(2),
      equity: equity.toFixed(2),
      balanced: assets.eq(liabilities.plus(equity)),
    });
  }
  return {
    kind: q.kind,
    summary,
    rows,
    count: rows.length,
    currency: (await db.project.findUniqueOrThrow({ where: { id: projectId } })).currency,
  };
}
export async function dashboard(projectId: string, phase?: string) {
  const cacheKey = `pms:dashboard:${projectId}:${phase ?? ''}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as unknown;
  const result = await transaction(async (tx) => {
    const project = found(await tx.project.findUnique({ where: { id: projectId } }));
    const unit = { projectId, phase };
    const inventory = await tx.unit.groupBy({ by: ['status'], where: unit, _count: true });
    const sales = await tx.booking.aggregate({
      where: { unit, status: 'CONFIRMED' },
      _sum: { total: true },
      _count: true,
    });
    const collections = await tx.payment.aggregate({
      where: { booking: { unit }, status: 'CLEARED' },
      _sum: { amount: true },
    });
    const dueRows = await queryReport(tx, projectId, { kind: 'installments', phase }, 100000);
    requireState(
      dueRows.length <= 100000,
      'DASHBOARD_TOO_LARGE',
      'This dashboard requires materialized reporting configuration.',
      422,
    );
    const outstanding = sum(dueRows.map((r) => String(r.outstanding)));
    const overdue = sum(dueRows.map((r) => String(r.overdue)));
    const defaulters = new Set(
      dueRows.filter((r) => decimal(String(r.overdue)).gt(0)).map((r) => r.customerId),
    ).size;
    const upcoming = dueRows.filter(
      (r) => r.lateDays === 0 && decimal(String(r.outstanding)).gt(0),
    );
    return {
      asOf: new Date().toISOString(),
      currency: project.currency,
      timezone: project.timezone,
      inventory: Object.fromEntries(inventory.map((i) => [i.status, i._count])),
      totalInventory: inventory.reduce((s, i) => s + i._count, 0),
      confirmedBookings: sales._count,
      netSales: sales._sum.total?.toFixed(2) ?? '0.00',
      verifiedCollections: collections._sum.amount?.toFixed(2) ?? '0.00',
      outstanding: outstanding.toFixed(2),
      overdue: overdue.toFixed(2),
      defaulterCount: defaulters,
      upcomingInstallments: upcoming.length,
    };
  });
  await redis.set(cacheKey, JSON.stringify(result), 'EX', 15);
  return result;
}
export async function queueExport(
  ctx: Context,
  input: { report: ReportQuery; format: 'xlsx' | 'pdf' },
) {
  return transaction(async (tx) => {
    const job = await tx.backgroundJob.create({
      data: {
        projectId: ctx.projectId,
        createdBy: ctx.actor.id,
        kind: 'REPORT',
        payload: json(input),
      },
    });
    await outbox(tx, 'export', { jobId: job.id });
    await audit(tx, ctx, 'report.export_requested', job.id, { kind: input.report.kind });
    return job;
  });
}
