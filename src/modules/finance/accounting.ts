import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, lock, transaction } from '../../database/client.js';
import { found, requireState } from '../../common/errors.js';
import { endpoint, id, pageQuery, paged, pagination, uuid } from '../../common/http.js';
import { decimal, money, sum } from '../../common/money.js';
import { audit, reference } from '../../common/operations.js';
import { postJournal, reverseJournal } from './service.js';

const root = '/projects/:projectId';
const paymentMethods = z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER']);

const supplierPaymentBody = z
  .object({
    vendorId: uuid,
    purchaseId: uuid.nullable().optional(),
    paymentAccountId: uuid,
    amount: money.refine((value) => decimal(value).gt(0), 'Amount must be greater than zero.'),
    paidAt: z.iso.datetime(),
    method: paymentMethods,
    transactionReference: z.string().trim().max(200).nullable().optional(),
    notes: z.string().trim().max(1000).default(''),
  })
  .strict();

const expenseBody = z
  .object({
    purchaseId: uuid.nullable().optional(),
    unitId: uuid.nullable().optional(),
    vendorId: uuid.nullable().optional(),
    expenseAccountId: uuid,
    paymentAccountId: uuid,
    category: z.string().trim().min(2).max(100),
    treatment: z.enum(['OPERATING', 'CAPITALIZED']).default('OPERATING'),
    description: z.string().trim().min(3).max(1000),
    amount: money.refine((value) => decimal(value).gt(0), 'Amount must be greater than zero.'),
    incurredAt: z.iso.datetime(),
    method: paymentMethods,
    transactionReference: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export function accountingCompletionRoutes(app: Express) {
  endpoint(
    app,
    'get',
    root + '/supplier-payments',
    {
      permission: 'finance.read',
      summary: 'List supplier payment vouchers and purchase allocations',
      query: pageQuery.extend({ vendorId: uuid.optional(), purchaseId: uuid.optional() }),
    },
    async (ctx, _body, query) => {
      const where = {
        projectId: ctx.projectId,
        vendorId: query.vendorId,
        purchaseId: query.purchaseId,
        status: query.status,
        ...(query.from || query.to
          ? {
              paidAt: {
                gte: query.from ? new Date(query.from) : undefined,
                lt: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
              },
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.supplierPayment.findMany({
          where,
          ...pagination(query),
          include: {
            vendor: { select: { id: true, name: true } },
            purchase: { select: { id: true, reference: true, title: true } },
            paymentAccount: { select: { id: true, code: true, name: true } },
            journal: { select: { id: true, reference: true } },
            reversal: { select: { id: true, reference: true } },
          },
          orderBy: [{ paidAt: query.sort }, { id: query.sort }],
        }),
        db.supplierPayment.count({ where }),
      ]);
      return paged(items, total, query);
    },
  );

  endpoint(
    app,
    'post',
    root + '/supplier-payments',
    {
      permission: 'finance.post',
      summary: 'Post a supplier payment voucher with optional purchase allocation',
      body: supplierPaymentBody,
      status: 201,
    },
    async (ctx, body) =>
      transaction(async (tx) => {
        await lock(tx, 'Vendor', body.vendorId);
        const vendor = found(
          await tx.vendor.findFirst({ where: { id: body.vendorId, projectId: ctx.projectId } }),
        );
        const paymentAccount = found(
          await tx.account.findFirst({
            where: {
              id: body.paymentAccountId,
              projectId: ctx.projectId,
              type: 'ASSET',
              active: true,
            },
          }),
          'Choose an active cash or bank asset account.',
        );
        const purchase = body.purchaseId
          ? found(
              await tx.propertyPurchase.findFirst({
                where: {
                  id: body.purchaseId,
                  projectId: ctx.projectId,
                  vendorId: vendor.id,
                  status: 'POSTED',
                },
              }),
              'The selected posted purchase does not belong to this supplier.',
            )
          : null;
        if (purchase) {
          await lock(tx, 'PropertyPurchase', purchase.id);
          const allocated = await tx.supplierPayment.aggregate({
            where: { purchaseId: purchase.id, status: 'POSTED' },
            _sum: { amount: true },
          });
          const outstanding = purchase.price.minus(allocated._sum.amount ?? 0);
          requireState(
            decimal(body.amount).lte(outstanding),
            'PAYMENT_EXCEEDS_PURCHASE_BALANCE',
            `The purchase has ${outstanding.toFixed(2)} remaining.`,
            422,
          );
        }
        const payable = found(
          await tx.account.findFirst({
            where: {
              projectId: ctx.projectId,
              code: 'SYS-SELLER-PAYABLES',
              type: 'LIABILITY',
              active: true,
            },
          }),
          'Post the property purchase before recording a supplier payment.',
        );
        const paymentId = randomUUID();
        const journal = await postJournal(tx, ctx, {
          source: 'SUPPLIER_PAYMENT',
          sourceId: paymentId,
          description: purchase
            ? `Payment to ${vendor.name} against ${purchase.reference}`
            : `Payment to supplier ${vendor.name}`,
          postedAt: new Date(body.paidAt),
          lines: [
            { accountId: payable.id, vendorId: vendor.id, debit: body.amount, credit: '0' },
            { accountId: paymentAccount.id, debit: '0', credit: body.amount },
          ],
        });
        const record = await tx.supplierPayment.create({
          data: {
            id: paymentId,
            projectId: ctx.projectId,
            vendorId: vendor.id,
            purchaseId: purchase?.id,
            paymentAccountId: paymentAccount.id,
            reference: await reference(tx, 'SPV'),
            amount: body.amount,
            paidAt: new Date(body.paidAt),
            method: body.method,
            transactionReference: body.transactionReference,
            notes: body.notes,
            journalId: journal.id,
            createdBy: ctx.actor.id,
          },
          include: { vendor: true, purchase: true, paymentAccount: true, journal: true },
        });
        await audit(tx, ctx, 'supplier_payment.posted', record.id, {
          purchaseId: purchase?.id,
          amount: body.amount,
        });
        return record;
      }),
  );

  endpoint(
    app,
    'post',
    root + '/supplier-payments/:id/reverse',
    {
      permission: 'finance.reverse',
      summary: 'Reverse a supplier payment voucher without changing its original journal',
      body: z.object({ reason: z.string().trim().min(3).max(1000) }).strict(),
    },
    async (ctx, body, _query, req) =>
      transaction(async (tx) => {
        await lock(tx, 'SupplierPayment', id(req));
        const payment = found(
          await tx.supplierPayment.findFirst({
            where: { id: id(req), projectId: ctx.projectId },
          }),
        );
        requireState(
          payment.status === 'POSTED',
          'ALREADY_REVERSED',
          'Payment is already reversed.',
        );
        const reversal = await reverseJournal(tx, ctx, payment.journalId, body.reason);
        const result = await tx.supplierPayment.update({
          where: { id: payment.id },
          data: { status: 'REVERSED', reversalId: reversal.id },
        });
        await audit(tx, ctx, 'supplier_payment.reversed', payment.id, { reason: body.reason });
        return result;
      }),
  );

  endpoint(
    app,
    'get',
    root + '/expenses',
    {
      permission: 'finance.read',
      summary: 'List centralized operating and capitalized expenses',
      query: pageQuery.extend({
        accountId: uuid.optional(),
        unitId: uuid.optional(),
        purchaseId: uuid.optional(),
        category: z.string().max(100).optional(),
        treatment: z.enum(['OPERATING', 'CAPITALIZED']).optional(),
      }),
    },
    async (ctx, _body, query) => {
      const where = {
        projectId: ctx.projectId,
        expenseAccountId: query.accountId,
        unitId: query.unitId,
        purchaseId: query.purchaseId,
        category: query.category,
        treatment: query.treatment,
        status: query.status,
        ...(query.from || query.to
          ? {
              incurredAt: {
                gte: query.from ? new Date(query.from) : undefined,
                lt: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
              },
            }
          : {}),
        ...(query.search
          ? { description: { contains: query.search, mode: 'insensitive' as const } }
          : {}),
      };
      const [items, total, totals] = await Promise.all([
        db.expense.findMany({
          where,
          ...pagination(query),
          include: {
            expenseAccount: { select: { id: true, code: true, name: true } },
            paymentAccount: { select: { id: true, code: true, name: true } },
            unit: { select: { id: true, number: true } },
            purchase: { select: { id: true, reference: true, title: true } },
            vendor: { select: { id: true, name: true } },
            journal: { select: { id: true, reference: true } },
          },
          orderBy: [{ incurredAt: query.sort }, { id: query.sort }],
        }),
        db.expense.count({ where }),
        db.expense.groupBy({
          by: ['treatment'],
          where: { ...where, status: 'POSTED' },
          _sum: { amount: true },
        }),
      ]);
      return {
        ...paged(items, total, query),
        summary: Object.fromEntries(
          totals.map((entry) => [entry.treatment, entry._sum.amount?.toFixed(2) ?? '0.00']),
        ),
      };
    },
  );

  endpoint(
    app,
    'post',
    root + '/expenses',
    {
      permission: 'finance.post',
      summary: 'Post an independent expense with an optional property or purchase link',
      body: expenseBody,
      status: 201,
    },
    async (ctx, body) =>
      transaction(async (tx) => {
        const expectedType = body.treatment === 'OPERATING' ? 'EXPENSE' : 'ASSET';
        const expenseAccount = found(
          await tx.account.findFirst({
            where: {
              id: body.expenseAccountId,
              projectId: ctx.projectId,
              type: expectedType,
              active: true,
            },
          }),
          body.treatment === 'OPERATING'
            ? 'Operating expenses require an active expense account.'
            : 'Capitalized costs require an active asset or work-in-progress account.',
        );
        const paymentAccount = found(
          await tx.account.findFirst({
            where: {
              id: body.paymentAccountId,
              projectId: ctx.projectId,
              type: 'ASSET',
              active: true,
            },
          }),
          'Choose an active cash or bank asset account.',
        );
        const purchase = body.purchaseId
          ? found(
              await tx.propertyPurchase.findFirst({
                where: { id: body.purchaseId, projectId: ctx.projectId, status: 'POSTED' },
              }),
            )
          : null;
        const unit = body.unitId
          ? found(await tx.unit.findFirst({ where: { id: body.unitId, projectId: ctx.projectId } }))
          : null;
        if (purchase?.unitId && unit)
          requireState(
            purchase.unitId === unit.id,
            'PROPERTY_PURCHASE_MISMATCH',
            'The selected property is not linked to this purchase.',
            422,
          );
        if (body.vendorId)
          found(
            await tx.vendor.findFirst({ where: { id: body.vendorId, projectId: ctx.projectId } }),
          );
        const expenseId = randomUUID();
        const journal = await postJournal(tx, ctx, {
          source: 'EXPENSE',
          sourceId: expenseId,
          description: body.description,
          postedAt: new Date(body.incurredAt),
          lines: [
            {
              accountId: expenseAccount.id,
              vendorId: body.vendorId,
              debit: body.amount,
              credit: '0',
            },
            { accountId: paymentAccount.id, debit: '0', credit: body.amount },
          ],
        });
        const record = await tx.expense.create({
          data: {
            id: expenseId,
            projectId: ctx.projectId,
            purchaseId: purchase?.id,
            unitId: unit?.id ?? purchase?.unitId,
            vendorId: body.vendorId,
            expenseAccountId: expenseAccount.id,
            paymentAccountId: paymentAccount.id,
            reference: await reference(tx, 'EXP'),
            category: body.category,
            treatment: body.treatment,
            description: body.description,
            amount: body.amount,
            incurredAt: new Date(body.incurredAt),
            method: body.method,
            transactionReference: body.transactionReference,
            journalId: journal.id,
            createdBy: ctx.actor.id,
          },
          include: { expenseAccount: true, paymentAccount: true, unit: true, purchase: true },
        });
        await audit(tx, ctx, 'expense.posted', record.id, {
          treatment: record.treatment,
          amount: record.amount.toFixed(2),
          unitId: record.unitId,
        });
        return record;
      }),
  );

  endpoint(
    app,
    'post',
    root + '/expenses/:id/reverse',
    {
      permission: 'finance.reverse',
      summary: 'Reverse an expense while retaining its audit history',
      body: z.object({ reason: z.string().trim().min(3).max(1000) }).strict(),
    },
    async (ctx, body, _query, req) =>
      transaction(async (tx) => {
        await lock(tx, 'Expense', id(req));
        const expense = found(
          await tx.expense.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        requireState(
          expense.status === 'POSTED',
          'ALREADY_REVERSED',
          'Expense is already reversed.',
        );
        const reversal = await reverseJournal(tx, ctx, expense.journalId, body.reason);
        const result = await tx.expense.update({
          where: { id: expense.id },
          data: { status: 'REVERSED', reversalId: reversal.id },
        });
        await audit(tx, ctx, 'expense.reversed', expense.id, { reason: body.reason });
        return result;
      }),
  );

  endpoint(
    app,
    'get',
    root + '/partners',
    { permission: 'finance.read', summary: 'List partners and current capital balances' },
    async (ctx) => {
      const partners = await db.partner.findMany({
        where: { projectId: ctx.projectId },
        include: { capitalAccount: true, transactions: { where: { status: 'POSTED' } } },
        orderBy: { name: 'asc' },
      });
      return partners.map(({ transactions, ...partner }) => ({
        ...partner,
        contributions: sum(
          transactions
            .filter((entry) => entry.kind === 'CONTRIBUTION')
            .map((entry) => entry.amount),
        ).toFixed(2),
        withdrawals: sum(
          transactions.filter((entry) => entry.kind === 'WITHDRAWAL').map((entry) => entry.amount),
        ).toFixed(2),
        balance: sum(
          transactions.map((entry) =>
            entry.kind === 'CONTRIBUTION' ? entry.amount : entry.amount.negated(),
          ),
        ).toFixed(2),
      }));
    },
  );

  endpoint(
    app,
    'post',
    root + '/partners',
    {
      permission: 'finance.post',
      summary: 'Create a partner with a dedicated capital account',
      body: z
        .object({
          name: z.string().trim().min(2).max(200),
          phone: z.string().trim().max(30).nullable().optional(),
          email: z.email().max(254).nullable().optional(),
        })
        .strict(),
      status: 201,
    },
    async (ctx, body) =>
      transaction(async (tx) => {
        requireState(
          !(await tx.partner.findFirst({
            where: { projectId: ctx.projectId, name: { equals: body.name, mode: 'insensitive' } },
          })),
          'DUPLICATE_PARTNER',
          'A partner with this name already exists.',
          409,
        );
        const code = await reference(tx, 'CAP');
        const account = await tx.account.create({
          data: {
            projectId: ctx.projectId,
            code,
            name: `${body.name} capital`,
            type: 'EQUITY',
            category: 'CAPITAL',
          },
        });
        const partner = await tx.partner.create({
          data: { ...body, projectId: ctx.projectId, capitalAccountId: account.id },
          include: { capitalAccount: true },
        });
        await audit(tx, ctx, 'partner.created', partner.id, { capitalAccountId: account.id });
        return partner;
      }),
  );

  endpoint(
    app,
    'get',
    root + '/partners/:id',
    { permission: 'finance.read', summary: 'Get a partner and capital transaction history' },
    async (ctx, _body, _query, req) =>
      found(
        await db.partner.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          include: {
            capitalAccount: true,
            transactions: {
              include: { cashAccount: true, journal: { select: { reference: true } } },
              orderBy: { transactedAt: 'desc' },
            },
          },
        }),
      ),
  );

  endpoint(
    app,
    'get',
    root + '/capital-transactions',
    {
      permission: 'finance.read',
      summary: 'List partner capital contribution and withdrawal vouchers',
      query: pageQuery.extend({ partnerId: uuid.optional() }),
    },
    async (ctx, _body, query) => {
      const where = {
        projectId: ctx.projectId,
        partnerId: query.partnerId,
        status: query.status,
        ...(query.from || query.to
          ? {
              transactedAt: {
                gte: query.from ? new Date(query.from) : undefined,
                lt: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
              },
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.capitalTransaction.findMany({
          where,
          ...pagination(query),
          include: {
            partner: { select: { id: true, name: true } },
            cashAccount: { select: { id: true, code: true, name: true } },
            journal: { select: { id: true, reference: true } },
          },
          orderBy: [{ transactedAt: query.sort }, { id: query.sort }],
        }),
        db.capitalTransaction.count({ where }),
      ]);
      return paged(items, total, query);
    },
  );

  endpoint(
    app,
    'post',
    root + '/capital-transactions',
    {
      permission: 'finance.post',
      summary: 'Post a partner capital contribution or withdrawal',
      body: z
        .object({
          partnerId: uuid,
          cashAccountId: uuid,
          kind: z.enum(['CONTRIBUTION', 'WITHDRAWAL']),
          amount: money.refine(
            (value) => decimal(value).gt(0),
            'Amount must be greater than zero.',
          ),
          transactedAt: z.iso.datetime(),
          description: z.string().trim().min(3).max(1000),
        })
        .strict(),
      status: 201,
    },
    async (ctx, body) =>
      transaction(async (tx) => {
        const partner = found(
          await tx.partner.findFirst({
            where: { id: body.partnerId, projectId: ctx.projectId, active: true },
          }),
        );
        const cash = found(
          await tx.account.findFirst({
            where: {
              id: body.cashAccountId,
              projectId: ctx.projectId,
              type: 'ASSET',
              active: true,
            },
          }),
          'Choose an active cash or bank asset account.',
        );
        const transactionId = randomUUID();
        const contribution = body.kind === 'CONTRIBUTION';
        const journal = await postJournal(tx, ctx, {
          source: 'CAPITAL_TRANSACTION',
          sourceId: transactionId,
          description: body.description,
          postedAt: new Date(body.transactedAt),
          lines: contribution
            ? [
                { accountId: cash.id, debit: body.amount, credit: '0' },
                { accountId: partner.capitalAccountId, debit: '0', credit: body.amount },
              ]
            : [
                { accountId: partner.capitalAccountId, debit: body.amount, credit: '0' },
                { accountId: cash.id, debit: '0', credit: body.amount },
              ],
        });
        const record = await tx.capitalTransaction.create({
          data: {
            id: transactionId,
            projectId: ctx.projectId,
            partnerId: partner.id,
            cashAccountId: cash.id,
            reference: await reference(tx, 'CPV'),
            kind: body.kind,
            amount: body.amount,
            transactedAt: new Date(body.transactedAt),
            description: body.description,
            journalId: journal.id,
            createdBy: ctx.actor.id,
          },
          include: { partner: true, cashAccount: true, journal: true },
        });
        await audit(tx, ctx, 'capital_transaction.posted', record.id, {
          kind: record.kind,
          amount: record.amount.toFixed(2),
        });
        return record;
      }),
  );

  endpoint(
    app,
    'post',
    root + '/capital-transactions/:id/reverse',
    {
      permission: 'finance.reverse',
      summary: 'Reverse a partner capital transaction',
      body: z.object({ reason: z.string().trim().min(3).max(1000) }).strict(),
    },
    async (ctx, body, _query, req) =>
      transaction(async (tx) => {
        await lock(tx, 'CapitalTransaction', id(req));
        const entry = found(
          await tx.capitalTransaction.findFirst({
            where: { id: id(req), projectId: ctx.projectId },
          }),
        );
        requireState(
          entry.status === 'POSTED',
          'ALREADY_REVERSED',
          'Transaction is already reversed.',
        );
        const reversal = await reverseJournal(tx, ctx, entry.journalId, body.reason);
        const result = await tx.capitalTransaction.update({
          where: { id: entry.id },
          data: { status: 'REVERSED', reversalId: reversal.id },
        });
        await audit(tx, ctx, 'capital_transaction.reversed', entry.id, { reason: body.reason });
        return result;
      }),
  );

  endpoint(
    app,
    'get',
    root + '/vendors/:id/statement',
    {
      permission: 'finance.read',
      summary: 'Get supplier purchases, payment history and outstanding balances',
    },
    async (ctx, _body, _query, req) => {
      const vendor = found(
        await db.vendor.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          include: {
            purchases: {
              where: { status: 'POSTED' },
              include: {
                unit: { select: { id: true, number: true } },
                payments: { where: { status: 'POSTED' }, orderBy: { paidAt: 'asc' } },
              },
              orderBy: { purchaseDate: 'asc' },
            },
            supplierPayments: {
              where: { status: 'POSTED' },
              include: {
                purchase: { select: { reference: true } },
                paymentAccount: { select: { code: true, name: true } },
              },
              orderBy: { paidAt: 'asc' },
            },
          },
        }),
      );
      const purchases = vendor.purchases.map((purchase) => {
        const paid = sum(purchase.payments.map((payment) => payment.amount));
        return {
          id: purchase.id,
          reference: purchase.reference,
          purchaseDate: purchase.purchaseDate.toISOString().slice(0, 10),
          title: purchase.title,
          propertyId: purchase.unit?.id ?? null,
          propertyNumber: purchase.unit?.number ?? null,
          purchaseAmount: purchase.price.toFixed(2),
          acquisitionCost: purchase.total.toFixed(2),
          paid: paid.toFixed(2),
          outstanding: purchase.price.minus(paid).toFixed(2),
        };
      });
      const purchaseAmount = sum(purchases.map((purchase) => purchase.purchaseAmount));
      const allocatedPayments = sum(purchases.map((purchase) => purchase.paid));
      const unallocatedPayments = sum(
        vendor.supplierPayments
          .filter((payment) => !payment.purchaseId)
          .map((payment) => payment.amount),
      );
      const allPayments = allocatedPayments.plus(unallocatedPayments);
      return {
        supplier: {
          id: vendor.id,
          name: vendor.name,
          category: vendor.category,
          phone: vendor.phone,
          email: vendor.email,
          address: vendor.address,
        },
        summary: {
          purchaseAmount: purchaseAmount.toFixed(2),
          allocatedPayments: allocatedPayments.toFixed(2),
          outstanding: purchaseAmount.minus(allocatedPayments).toFixed(2),
          unallocatedPayments: unallocatedPayments.toFixed(2),
          supplierLedgerBalance: purchaseAmount.minus(allPayments).toFixed(2),
        },
        purchases,
        payments: vendor.supplierPayments,
      };
    },
  );

  endpoint(
    app,
    'get',
    root + '/units/:id/financial-summary',
    {
      permission: 'finance.read',
      summary: 'Get property purchase, supplier payment, expense, sale and receipt position',
    },
    async (ctx, _body, _query, req) => {
      const unit = found(
        await db.unit.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          include: {
            purchases: {
              where: { status: 'POSTED' },
              include: {
                vendor: { select: { id: true, name: true } },
                payments: { where: { status: 'POSTED' }, orderBy: { paidAt: 'asc' } },
              },
            },
            expenses: {
              where: { status: 'POSTED' },
              include: { expenseAccount: { select: { code: true, name: true } } },
              orderBy: { incurredAt: 'asc' },
            },
            bookings: {
              where: { status: { in: ['DRAFT', 'CONFIRMED'] } },
              include: {
                customer: { select: { id: true, name: true } },
                payments: { where: { status: 'CLEARED' }, orderBy: { paidAt: 'asc' } },
                installments: {
                  where: { superseded: false },
                  include: { allocations: { where: { reversedAt: null } } },
                },
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        }),
      );
      const purchase = unit.purchases[0];
      const paidToSupplier = sum(purchase?.payments.map((payment) => payment.amount) ?? []);
      const booking = unit.bookings[0];
      const received = sum(booking?.payments.map((payment) => payment.amount) ?? []);
      const receivable = sum(
        booking?.installments.map((installment) =>
          installment.amount.minus(
            sum(installment.allocations.map((allocation) => allocation.amount)),
          ),
        ) ?? [],
      );
      const operatingExpenses = sum(
        unit.expenses
          .filter((expense) => expense.treatment === 'OPERATING')
          .map((expense) => expense.amount),
      );
      const capitalizedCosts = sum(
        unit.expenses
          .filter((expense) => expense.treatment === 'CAPITALIZED')
          .map((expense) => expense.amount),
      );
      const acquisitionCost = purchase?.total ?? decimal(0);
      const propertyCost = acquisitionCost.plus(capitalizedCosts);
      return {
        property: {
          id: unit.id,
          number: unit.number,
          type: unit.type,
          status: unit.status,
        },
        purchase: purchase
          ? {
              id: purchase.id,
              reference: purchase.reference,
              supplier: purchase.vendor,
              purchasePrice: purchase.price.toFixed(2),
              acquisitionCost: purchase.total.toFixed(2),
              paidToSupplier: paidToSupplier.toFixed(2),
              supplierOutstanding: purchase.price.minus(paidToSupplier).toFixed(2),
              payments: purchase.payments,
            }
          : null,
        expenses: {
          operating: operatingExpenses.toFixed(2),
          capitalized: capitalizedCosts.toFixed(2),
          records: unit.expenses,
        },
        sale: booking
          ? {
              id: booking.id,
              reference: booking.reference,
              customer: booking.customer,
              saleAmount: booking.total.toFixed(2),
              received: received.toFixed(2),
              outstanding: receivable.toFixed(2),
              payments: booking.payments,
            }
          : null,
        profitability: {
          propertyCost: propertyCost.toFixed(2),
          projectedProfit: booking ? booking.total.minus(propertyCost).toFixed(2) : null,
          realizedProfit:
            booking?.status === 'CONFIRMED' && received.gte(booking.total)
              ? booking.total.minus(propertyCost).toFixed(2)
              : null,
          operatingExpenses: operatingExpenses.toFixed(2),
        },
      };
    },
  );
}
