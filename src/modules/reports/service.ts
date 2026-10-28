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
  'defaulters',
  'dealer-sales',
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
  'deal-profitability',
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
    case 'deal-profitability': {
      const purchases = await tx.propertyPurchase.findMany({
        where: {
          projectId,
          status: { in: ['POSTED', 'DRAFT'] },
          ...(q.from || q.to ? { purchaseDate: dates } : {}),
        },
        include: {
          vendor: { select: { id: true, name: true, phone: true } },
          unit: {
            select: {
              id: true,
              number: true,
              type: true,
              phase: true,
              size: true,
              measurementUnit: true,
              status: true,
              price: true,
              bookings: {
                where: { status: { in: ['CONFIRMED', 'DRAFT'] } },
                select: {
                  id: true,
                  reference: true,
                  total: true,
                  status: true,
                  createdAt: true,
                  customer: { select: { id: true, name: true, phone: true } },
                  payments: {
                    where: { status: 'CLEARED' },
                    select: { amount: true },
                  },
                },
                take: 1,
              },
            },
          },
          dealer: { select: { id: true, name: true } },
        },
        take,
        orderBy: { purchaseDate: 'desc' },
      });

      return purchases.map((p) => {
        const booking = p.unit?.bookings?.[0];
        const extraExpenses = p.total.minus(p.price);
        const salePrice = booking ? booking.total : null;
        const netProfit = salePrice ? salePrice.minus(p.total) : null;
        const profitMargin =
          salePrice && p.total.gt(0)
            ? netProfit!.div(p.total).mul(100).toFixed(1)
            : null;
        const collected = booking
          ? sum(booking.payments.map((pm) => pm.amount)).toFixed(2)
          : '0.00';

        return {
          id: p.id,
          reference: p.reference,
          fileReference: p.fileReference,
          title: p.title,
          location: p.location,
          purchaseDate: p.purchaseDate.toISOString().slice(0, 10),
          purchaseStatus: p.status,
          sellerName: p.vendor?.name ?? '',
          sellerPhone: p.vendor?.phone ?? '',
          buyPrice: p.price.toFixed(2),
          taxes: p.taxes.toFixed(2),
          legalFees: p.legalFees.toFixed(2),
          brokerage: p.brokerage.toFixed(2),
          otherCosts: p.otherCosts.toFixed(2),
          totalExpenses: extraExpenses.toFixed(2),
          totalCost: p.total.toFixed(2),
          unitNumber: p.unit?.number ?? '',
          unitType: p.unit?.type ?? '',
          unitPhase: p.unit?.phase ?? '',
          unitSize: p.unit?.size
            ? `${p.unit.size} ${p.unit.measurementUnit ?? ''}`.trim()
            : '',
          buyerName: booking?.customer?.name ?? '',
          buyerPhone: booking?.customer?.phone ?? '',
          bookingReference: booking?.reference ?? '',
          bookingStatus: booking?.status ?? '',
          salePrice: salePrice ? salePrice.toFixed(2) : '',
          collectedAmount: collected,
          netProfit: netProfit ? netProfit.toFixed(2) : '',
          profitMarginPercent: profitMargin ? `${profitMargin}%` : '',
          dealStatus: booking
            ? booking.status === 'CONFIRMED'
              ? 'SOLD'
              : 'BOOKED'
            : p.status === 'POSTED'
              ? 'AVAILABLE'
              : 'DRAFT',
        };
      });
    }
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
          booking: {
            select: {
              reference: true,
              customerId: true,
              customer: { select: { name: true, phone: true } },
              unit: { select: { number: true, type: true } },
            },
          },
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
            customerName: r.booking.customer?.name ?? '',
            customerPhone: r.booking.customer?.phone ?? '',
            unitNumber: r.booking.unit?.number ?? '',
            unitType: r.booking.unit?.type ?? '',
            label: r.label,
            sequence: r.sequence,
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
    case 'defaulters': {
      const rows = await tx.installment.findMany({
        where: {
          booking: { ...bookingWhere, status: { not: 'CANCELLED' } },
          superseded: false,
        },
        include: {
          allocations: { where: { reversedAt: null } },
          booking: {
            select: {
              reference: true,
              customerId: true,
              customer: { select: { name: true, phone: true } },
              unit: { select: { number: true, type: true } },
              recovery: { select: { status: true }, take: 1 },
            },
          },
        },
        orderBy: { dueDate: 'asc' },
      });
      const today = DateTime.now().setZone(project.timezone).toISODate()!;
      const now = new Date(today).getTime();

      const map = new Map<
        string,
        {
          bookingId: string;
          reference: string;
          customerId: string;
          customerName: string;
          customerPhone: string;
          propertyNumber: string;
          propertyType: string;
          overdueInstallmentsCount: number;
          overdueAmount: Prisma.Decimal;
          totalOutstanding: Prisma.Decimal;
          oldestDueDate: string;
          daysOverdue: number;
          collectionStatus: string;
        }
      >();

      for (const r of rows) {
        const paid = sum(r.allocations.map((a) => a.amount));
        const due = r.amount.minus(paid);
        if (due.lte(0)) continue;
        const lateDays = Math.max(0, Math.floor((now - r.dueDate.getTime()) / 86400000));
        let item = map.get(r.bookingId);
        if (!item) {
          item = {
            bookingId: r.bookingId,
            reference: r.booking.reference,
            customerId: r.booking.customerId,
            customerName: r.booking.customer?.name ?? '',
            customerPhone: r.booking.customer?.phone ?? '',
            propertyNumber: r.booking.unit?.number ?? '',
            propertyType: r.booking.unit?.type ?? '',
            overdueInstallmentsCount: 0,
            overdueAmount: decimal(0),
            totalOutstanding: decimal(0),
            oldestDueDate: '',
            daysOverdue: 0,
            collectionStatus: r.booking.recovery[0]?.status ?? 'OVERDUE',
          };
          map.set(r.bookingId, item);
        }
        item.totalOutstanding = item.totalOutstanding.plus(due);
        if (lateDays > 0) {
          item.overdueInstallmentsCount += 1;
          item.overdueAmount = item.overdueAmount.plus(due);
          if (lateDays > item.daysOverdue) item.daysOverdue = lateDays;
          const dueStr = r.dueDate.toISOString().slice(0, 10);
          if (!item.oldestDueDate || dueStr < item.oldestDueDate) item.oldestDueDate = dueStr;
        }
      }

      return [...map.values()]
        .filter((d) => d.overdueInstallmentsCount > 0 && d.overdueAmount.gt(0))
        .map((d) => ({
          bookingId: d.bookingId,
          reference: d.reference,
          customerId: d.customerId,
          customerName: d.customerName,
          customerPhone: d.customerPhone,
          propertyNumber: d.propertyNumber,
          propertyType: d.propertyType,
          overdueInstallmentsCount: d.overdueInstallmentsCount,
          overdueAmount: d.overdueAmount.toFixed(2),
          totalOutstanding: d.totalOutstanding.toFixed(2),
          oldestDueDate: d.oldestDueDate,
          daysOverdue: d.daysOverdue,
          collectionStatus: d.collectionStatus,
        }));
    }
    case 'dealer-sales': {
      const dealers = await tx.dealer.findMany({
        where: { projectId },
        include: {
          allocations: { select: { unitId: true } },
          bookings: {
            where: { unit: { projectId }, status: 'CONFIRMED' },
            select: { total: true },
          },
          commissions: { select: { amount: true, status: true } },
        },
      });
      return dealers.map((d) => {
        const totalSales = sum(d.bookings.map((b) => b.total));
        const totalCommission = sum(d.commissions.map((c) => c.amount));
        const settledCommission = sum(
          d.commissions.filter((c) => c.status === 'COMPLETED').map((c) => c.amount),
        );
        return {
          dealerId: d.id,
          name: d.name,
          phone: d.phone,
          active: d.active,
          commissionPercent: d.commissionPercent.toFixed(2),
          assignedProperties: d.allocations.length,
          soldProperties: d.bookings.length,
          totalSalesValue: totalSales.toFixed(2),
          totalCommission: totalCommission.toFixed(2),
          commissionPaid: settledCommission.toFixed(2),
          commissionPending: totalCommission.minus(settledCommission).toFixed(2),
        };
      });
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
  if (q.kind === 'deal-profitability') {
    const totalBuy = sum(rows.map((r) => String(r.buyPrice || 0)));
    const totalExp = sum(rows.map((r) => String(r.totalExpenses || 0)));
    const totalCost = sum(rows.map((r) => String(r.totalCost || 0)));
    const soldRows = rows.filter((r) => Boolean(r.salePrice));
    const totalSales = sum(soldRows.map((r) => String(r.salePrice)));
    const soldCost = sum(soldRows.map((r) => String(r.totalCost)));
    const netProfit = totalSales.minus(soldCost);
    const avgMargin = soldCost.gt(0) ? netProfit.div(soldCost).mul(100).toFixed(1) : '0.0';

    Object.assign(summary, {
      totalDeals: rows.length,
      soldCount: soldRows.length,
      availableCount: rows.length - soldRows.length,
      totalBuyPrice: totalBuy.toFixed(2),
      totalExpenses: totalExp.toFixed(2),
      totalInvestedCost: totalCost.toFixed(2),
      totalSalesRevenue: totalSales.toFixed(2),
      totalNetProfit: netProfit.toFixed(2),
      averageMarginPercent: avgMargin,
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

export async function dealsProfitability(projectId: string) {
  return transaction(async (tx) => {
    const project = found(await tx.project.findUnique({ where: { id: projectId } }));
    const purchases = await tx.propertyPurchase.findMany({
      where: {
        projectId,
        status: { in: ['POSTED', 'DRAFT'] },
      },
      include: {
        vendor: { select: { id: true, name: true, phone: true } },
        unit: {
          select: {
            id: true,
            number: true,
            type: true,
            phase: true,
            block: true,
            size: true,
            measurementUnit: true,
            status: true,
            price: true,
            bookings: {
              where: { status: { in: ['CONFIRMED', 'DRAFT'] } },
              select: {
                id: true,
                reference: true,
                total: true,
                status: true,
                createdAt: true,
                customer: { select: { id: true, name: true, phone: true } },
                payments: {
                  where: { status: 'CLEARED' },
                  select: { amount: true },
                },
              },
              take: 1,
            },
          },
        },
        dealer: { select: { id: true, name: true, phone: true } },
        journal: { select: { id: true, reference: true } },
      },
      orderBy: { purchaseDate: 'desc' },
    });

    const deals = purchases.map((p) => {
      const booking = p.unit?.bookings?.[0];
      const extraExpenses = p.total.minus(p.price);
      const salePrice = booking ? booking.total : null;
      const netProfit = salePrice ? salePrice.minus(p.total) : null;
      const profitMarginPercent =
        salePrice && p.total.gt(0)
          ? netProfit!.div(p.total).mul(100).toFixed(1)
          : null;
      const collectedAmount = booking
        ? sum(booking.payments.map((pm) => pm.amount)).toFixed(2)
        : '0.00';

      const items = Array.isArray(p.expenseItems)
        ? (p.expenseItems as Array<{ id?: string; name: string; category?: string; amount: string | number }>).map(
            (i) => ({
              id: i.id ?? '',
              name: i.name,
              category: i.category ?? 'Renovation & Building',
              amount: String(i.amount),
            }),
          )
        : [];

      return {
        id: p.id,
        reference: p.reference,
        fileReference: p.fileReference,
        title: p.title,
        location: p.location,
        purchaseDate: p.purchaseDate.toISOString().slice(0, 10),
        status: p.status,
        seller: {
          id: p.vendor?.id ?? '',
          name: p.vendor?.name ?? '—',
          phone: p.vendor?.phone ?? '',
        },
        buyPrice: p.price.toFixed(2),
        expenses: {
          taxes: p.taxes.toFixed(2),
          legalFees: p.legalFees.toFixed(2),
          brokerage: p.brokerage.toFixed(2),
          otherCosts: p.otherCosts.toFixed(2),
          items,
          total: extraExpenses.toFixed(2),
        },
        totalCost: p.total.toFixed(2),
        unit: p.unit
          ? {
              id: p.unit.id,
              number: p.unit.number,
              type: p.unit.type,
              phase: p.unit.phase,
              block: p.unit.block,
              size: `${p.unit.size} ${p.unit.measurementUnit ?? ''}`.trim(),
              status: p.unit.status,
              listedPrice: p.unit.price.toFixed(2),
            }
          : null,
        buyer: booking?.customer
          ? {
              id: booking.customer.id,
              name: booking.customer.name,
              phone: booking.customer.phone ?? '',
              bookingId: booking.id,
              bookingReference: booking.reference,
              bookingStatus: booking.status,
            }
          : null,
        salePrice: salePrice ? salePrice.toFixed(2) : null,
        collected: collectedAmount,
        netProfit: netProfit ? netProfit.toFixed(2) : null,
        profitMarginPercent: profitMarginPercent ? `${profitMarginPercent}%` : null,
        dealStatus: (booking
          ? booking.status === 'CONFIRMED'
            ? 'SOLD'
            : 'BOOKED'
          : p.status === 'POSTED'
            ? 'AVAILABLE'
            : 'DRAFT') as 'SOLD' | 'BOOKED' | 'AVAILABLE' | 'DRAFT',
      };
    });

    const totalBuy = sum(deals.map((d) => d.buyPrice));
    const totalExp = sum(deals.map((d) => d.expenses.total));
    const totalCost = sum(deals.map((d) => d.totalCost));
    const soldDeals = deals.filter((d) => d.salePrice !== null);
    const totalSales = sum(soldDeals.map((d) => d.salePrice!));
    const soldCost = sum(soldDeals.map((d) => d.totalCost));
    const totalProfit = totalSales.minus(soldCost);
    const avgMargin = soldCost.gt(0) ? totalProfit.div(soldCost).mul(100).toFixed(1) : '0.0';

    return {
      currency: project.currency,
      summary: {
        totalAcquisitions: deals.length,
        soldCount: soldDeals.length,
        availableCount: deals.length - soldDeals.length,
        totalBuyPrice: totalBuy.toFixed(2),
        totalExpenses: totalExp.toFixed(2),
        totalInvestedCost: totalCost.toFixed(2),
        totalSalesRevenue: totalSales.toFixed(2),
        totalRealizedProfit: totalProfit.toFixed(2),
        averageMarginPercent: avgMargin,
      },
      deals,
    };
  });
}
export async function dashboard(projectId: string, phase?: string) {
  const cacheKey = `pms:dashboard:${projectId}:${phase ?? ''}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as unknown;
  const result = await transaction(async (tx) => {
    const project = found(await tx.project.findUnique({ where: { id: projectId } }));
    const totalProjects = await tx.project.count();
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
    const upcomingAmount = sum(upcoming.map((r) => String(r.outstanding)));

    const availableCount = inventory.find((i) => i.status === 'AVAILABLE')?._count ?? 0;
    const bookedCount = inventory.find((i) => i.status === 'BOOKED')?._count ?? 0;
    const soldCount = inventory.find((i) => i.status === 'SOLD')?._count ?? 0;

    const dealerCount = await tx.dealer.count({ where: { projectId, active: true } });

    return {
      asOf: new Date().toISOString(),
      currency: project.currency,
      timezone: project.timezone,
      totalProjects,
      inventory: Object.fromEntries(inventory.map((i) => [i.status, i._count])),
      totalInventory: inventory.reduce((s, i) => s + i._count, 0),
      availableProperties: availableCount,
      bookedProperties: bookedCount,
      soldProperties: soldCount,
      confirmedBookings: sales._count,
      netSales: sales._sum.total?.toFixed(2) ?? '0.00',
      totalSalesValue: sales._sum.total?.toFixed(2) ?? '0.00',
      verifiedCollections: collections._sum.amount?.toFixed(2) ?? '0.00',
      totalReceived: collections._sum.amount?.toFixed(2) ?? '0.00',
      outstanding: outstanding.toFixed(2),
      totalOutstanding: outstanding.toFixed(2),
      totalReceivables: outstanding.toFixed(2),
      overdue: overdue.toFixed(2),
      overdueInstallments: dueRows.filter((r) => decimal(String(r.overdue)).gt(0)).length,
      defaulterCount: defaulters,
      upcomingInstallments: upcoming.length,
      upcomingAmount: upcomingAmount.toFixed(2),
      activeDealers: dealerCount,
    };
  });
  await redis.set(cacheKey, JSON.stringify(result), 'EX', 15);
  return result;
}
export async function queueExport(
  ctx: Context,
  input: { report: ReportQuery; format: 'xlsx' | 'pdf' },
) {
  const job = await transaction(async (tx) => {
    const j = await tx.backgroundJob.create({
      data: {
        projectId: ctx.projectId,
        createdBy: ctx.actor.id,
        kind: 'REPORT',
        payload: json(input),
      },
    });
    await outbox(tx, 'export', { jobId: j.id });
    await audit(tx, ctx, 'report.export_requested', j.id, { kind: input.report.kind });
    return j;
  });

  // Ensure artifact is generated immediately so single-process dev and web servers fulfill downloads seamlessly
  import('../../jobs/artifacts.js').then((m) => m.generateArtifact(job.id)).catch(() => {});

  return job;
}
