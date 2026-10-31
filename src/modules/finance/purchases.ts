import type { Express } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Unit } from '@prisma/client';
import { db, transaction, lock, type Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { endpoint, uuid, id, pageQuery, pagination, paged } from '../../common/http.js';
import { positiveMoney, money, sum, decimal } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit, reference } from '../../common/operations.js';
import { postJournal, reverseJournal, type PostingLine } from './service.js';
import { unitState, scopedUnit, requireUncommittedUnit } from '../inventory/service.js';

const expenseItemSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().default('Renovation & Building'),
  amount: positiveMoney,
});

const body = z
  .object({
    unitId: uuid.optional().nullable(),
    dealerId: uuid.optional().nullable(),
    vendorId: uuid,
    title: z.string().trim().min(2).max(200),
    location: z.string().trim().min(2).max(500),
    purchaseDate: z.iso.date(),
    price: positiveMoney,
    taxes: money.default('0'),
    legalFees: money.default('0'),
    brokerage: money.default('0'),
    otherCosts: money.default('0'),
    expenseItems: z.array(expenseItemSchema).default([]),
    fileReference: z.string().trim().min(2).max(100),
    notes: z.string().trim().max(2000).default(''),
  })
  .strict();
const include = {
  vendor: { select: { id: true, name: true, phone: true } },
  unit: {
    select: { id: true, number: true, type: true, floor: true, size: true, measurementUnit: true },
  },
  dealer: { select: { id: true, name: true, phone: true } },
  journal: { select: { id: true, reference: true } },
  reversal: { select: { id: true, reference: true } },
} as const;

async function validate(tx: Tx, ctx: Context, input: z.infer<typeof body>, currentId?: string) {
  const seller = found(
    await tx.vendor.findFirst({ where: { id: input.vendorId, projectId: ctx.projectId } }),
  );
  requireState(
    ['SELLER', 'MULTI_ROLE'].includes(seller.category),
    'SELLER_REQUIRED',
    'Choose a seller or a multi-role business contact.',
    422,
  );
  if (input.unitId) {
    found(await tx.unit.findFirst({ where: { id: input.unitId, projectId: ctx.projectId } }));
    const existing = await tx.propertyPurchase.findFirst({
      where: {
        projectId: ctx.projectId,
        unitId: input.unitId,
        status: { in: ['DRAFT', 'POSTED'] },
        ...(currentId ? { id: { not: currentId } } : {}),
      },
      select: { id: true, reference: true },
    });
    requireState(
      !existing,
      'UNIT_ALREADY_PURCHASED',
      `This property/unit is already linked to property purchase ${existing?.reference ?? ''}. It cannot be acquired again.`,
      422,
    );
  }
  if (input.dealerId) {
    found(await tx.dealer.findFirst({ where: { id: input.dealerId, projectId: ctx.projectId } }));
  }
  const expenseItems = input.expenseItems.map((item) => ({
    ...item,
    id: item.id || crypto.randomUUID(),
  }));
  const renovationExpenseSum = sum(expenseItems.map((item) => item.amount));
  const combinedOtherCosts = decimal(input.otherCosts).plus(renovationExpenseSum).toFixed(2);
  const total = sum([
    input.price,
    input.taxes,
    input.legalFees,
    input.brokerage,
    combinedOtherCosts,
  ]);
  requireState(
    total.lt('10000000000000000'),
    'AMOUNT_TOO_LARGE',
    'The total acquisition cost is too large.',
    422,
  );
  return {
    ...input,
    expenseItems,
    otherCosts: combinedOtherCosts,
    purchaseDate: new Date(input.purchaseDate),
    total,
  };
}

// Reserved accounts keep acquisition inventory and accruals separate from cash
// and customer advances. Existing projects get these when first used.
async function purchaseAccounts(tx: Tx, projectId: string) {
  const definitions = [
    ['SYS-PROPERTY-INVENTORY', 'Property acquisition inventory', 'ASSET'],
    ['SYS-SELLER-PAYABLES', 'Property seller payables', 'LIABILITY'],
    ['SYS-ACQUISITION-ACCRUALS', 'Other acquisition costs payable', 'LIABILITY'],
  ] as const;
  const accounts = [];
  for (const [code, name, type] of definitions) {
    const account = await tx.account.upsert({
      where: { projectId_code: { projectId, code } },
      create: { projectId, code, name, type },
      update: {},
    });
    requireState(
      account.type === type && account.active,
      'ACQUISITION_ACCOUNT_INVALID',
      'The acquisition ledger accounts must be active and have the correct account type.',
      422,
    );
    accounts.push(account.id);
  }
  return { inventory: accounts[0]!, sellers: accounts[1]!, other: accounts[2]! };
}

export function purchaseRoutes(app: Express) {
  const root = '/projects/:projectId/property-purchases';
  endpoint(
    app,
    'get',
    root,
    {
      permission: 'finance.read',
      summary: 'List property acquisition costs and seller obligations',
      query: pageQuery.extend({ status: z.enum(['DRAFT', 'POSTED', 'VOIDED']).optional() }),
    },
    async (ctx, _b, q) => {
      const where = {
        projectId: ctx.projectId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.search
          ? {
              OR: [
                { title: { contains: q.search, mode: 'insensitive' as const } },
                { reference: { contains: q.search, mode: 'insensitive' as const } },
                { vendor: { name: { contains: q.search, mode: 'insensitive' as const } } },
                { unit: { number: { contains: q.search, mode: 'insensitive' as const } } },
                { dealer: { name: { contains: q.search, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.propertyPurchase.findMany({
          where,
          include,
          ...pagination(q),
          orderBy: [{ purchaseDate: q.sort }, { id: q.sort }],
        }),
        db.propertyPurchase.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    root + '/:id',
    {
      permission: 'finance.read',
      summary: 'Review a property purchase and its accounting voucher',
    },
    async (ctx, _b, _q, req) =>
      found(
        await db.propertyPurchase.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          include,
        }),
      ),
  );
  endpoint(
    app,
    'post',
    root,
    {
      permission: 'finance.post',
      summary: 'Create a draft property acquisition for resale or development',
      body,
      status: 201,
    },
    async (ctx, input) =>
      transaction(async (tx) => {
        await lock(tx, 'Project', ctx.projectId);
        let unitId = input.unitId;
        if (!unitId) {
          let unitNumber = input.title.trim();
          const existing = await tx.unit.findFirst({
            where: { projectId: ctx.projectId, number: unitNumber },
          });
          if (existing) {
            unitNumber = `${unitNumber}-${Date.now().toString().slice(-4)}`;
          }
          const createdUnit = await tx.unit.create({
            data: {
              projectId: ctx.projectId,
              number: unitNumber,
              type: 'PLOT',
              size: decimal('1'),
              measurementUnit: 'Unit',
              price: input.price,
              status: 'BLOCKED',
              phase: input.location || null,
            },
          });
          unitId = createdUnit.id;
          await unitState(tx, ctx, createdUnit.id, 'BLOCKED', 'Acquisition in progress');
        }
        const values = await validate(tx, ctx, { ...input, unitId });
        const record = await tx.propertyPurchase.create({
          data: {
            ...values,
            projectId: ctx.projectId,
            createdBy: ctx.actor.id,
            reference: await reference(tx, 'PUR'),
          },
          include,
        });
        await audit(tx, ctx, 'purchase.created', record.id, {
          reference: record.reference,
          total: record.total.toFixed(2),
        });
        return record;
      }),
  );
  endpoint(
    app,
    'patch',
    root + '/:id',
    { permission: 'finance.post', summary: 'Edit a draft property acquisition', body },
    async (ctx, input, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'Project', ctx.projectId);
        const current = found(
          await tx.propertyPurchase.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        requireState(
          current.status === 'DRAFT',
          'PURCHASE_LOCKED',
          'Posted or voided purchases cannot be edited. Reverse an incorrect posting before creating a replacement.',
        );
        const values = await validate(tx, ctx, input, current.id);
        const result = await tx.propertyPurchase.update({
          where: { id: current.id },
          data: values,
          include,
        });
        await audit(tx, ctx, 'purchase.updated', result.id, { total: result.total.toFixed(2) });
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/:id/post',
    {
      permission: 'finance.post',
      summary: 'Post acquisition inventory, seller payable and other acquisition accruals',
      body: z
        .object({ expectedTotal: positiveMoney, expectedUpdatedAt: z.iso.datetime() })
        .strict(),
    },
    async (ctx, input, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'Project', ctx.projectId);
        const current = found(
          await tx.propertyPurchase.findFirst({
            where: { id: id(req), projectId: ctx.projectId },
            include,
          }),
        );
        requireState(
          current.total.eq(input.expectedTotal),
          'PURCHASE_CHANGED',
          'The purchase cost changed. Review the current amounts before posting.',
        );
        if (current.status === 'POSTED') return current;
        requireState(
          current.updatedAt.toISOString() === input.expectedUpdatedAt,
          'PURCHASE_CHANGED',
          'The purchase details changed. Refresh and review them before posting.',
        );
        requireState(
          current.status === 'DRAFT',
          'PURCHASE_LOCKED',
          'Only a draft purchase can be posted.',
        );
        const project = found(
          await tx.project.findUnique({ where: { id: ctx.projectId }, select: { timezone: true } }),
        );
        requireState(
          current.purchaseDate.toISOString().slice(0, 10) <=
            DateTime.now().setZone(project.timezone).toISODate()!,
          'FUTURE_PURCHASE',
          'A future purchase can be saved as a draft but cannot be posted yet.',
          422,
        );
        const accounts = await purchaseAccounts(tx, ctx.projectId);
        const extra = current.total.minus(current.price);
        const lines: PostingLine[] = [
          { accountId: accounts.inventory, debit: current.total, credit: '0' },
          {
            accountId: accounts.sellers,
            vendorId: current.vendorId,
            debit: '0',
            credit: current.price,
          },
        ];
        if (extra.gt(0)) lines.push({ accountId: accounts.other, debit: '0', credit: extra });
        const journal = await postJournal(tx, ctx, {
          source: 'PROPERTY_PURCHASE',
          sourceId: current.id,
          description: current.reference + ': ' + current.title,
          postedAt: current.purchaseDate,
          lines,
        });
        const result = await tx.propertyPurchase.update({
          where: { id: current.id },
          data: {
            status: 'POSTED',
            journalId: journal.id,
            postedBy: ctx.actor.id,
            postedAt: new Date(),
          },
          include,
        });
        await audit(tx, ctx, 'purchase.posted', result.id, {
          journalId: journal.id,
          sellerPayable: current.price.toFixed(2),
          otherAccruals: extra.toFixed(2),
        });
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/:id/void',
    {
      permission: 'finance.reverse',
      summary: 'Void a draft or reverse a posted property acquisition',
      body: z.object({ reason: z.string().trim().min(5).max(1000) }).strict(),
    },
    async (ctx, input, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'Project', ctx.projectId);
        const current = found(
          await tx.propertyPurchase.findFirst({
            where: { id: id(req), projectId: ctx.projectId },
            include,
          }),
        );
        if (current.status === 'VOIDED') return current;
        if (current.unitId)
          await requireUncommittedUnit(tx, await scopedUnit(tx, ctx, current.unitId));
        const reversal = current.journalId
          ? await reverseJournal(
              tx,
              ctx,
              current.journalId,
              current.reference + ': ' + input.reason,
            )
          : null;
        const result = await tx.propertyPurchase.update({
          where: { id: current.id },
          data: { status: 'VOIDED', reversalId: reversal?.id, voidReason: input.reason },
          include,
        });
        if (current.unitId)
          await unitState(
            tx,
            ctx,
            current.unitId,
            'BLOCKED',
            'Acquisition voided; review before listing',
          );
        await audit(tx, ctx, 'purchase.voided', result.id, {
          reason: input.reason,
          reversalId: reversal?.id,
        });
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/:id/list-for-sale',
    {
      permission: 'inventory.create',
      summary:
        'Move an investment-finalized property to active selling inventory with asking price',
      body: z.object({ askingPrice: positiveMoney }).strict(),
    },
    async (ctx, input, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'Project', ctx.projectId);
        const current = found(
          await tx.propertyPurchase.findFirst({
            where: { id: id(req), projectId: ctx.projectId },
            include,
          }),
        );
        requireState(
          current.status === 'POSTED',
          'PURCHASE_NOT_FINALIZED',
          'Finalize and post the purchase investment and expenses before listing for sale.',
          422,
        );

        let unit: Unit;
        if (current.unitId) {
          unit = await scopedUnit(tx, ctx, current.unitId);
          await requireUncommittedUnit(tx, unit);
          unit = await tx.unit.update({
            where: { id: unit.id },
            data: { price: input.askingPrice, status: 'AVAILABLE' },
          });
          await unitState(tx, ctx, unit.id, 'AVAILABLE', 'Listed for sale');
        } else {
          // If the property had no unitId, auto-create the Unit in db.unit
          // so it immediately appears in Properties and the Booking dropdown!
          let unitNumber = current.title.trim();
          const existing = await tx.unit.findFirst({
            where: { projectId: ctx.projectId, number: unitNumber },
          });
          if (existing) {
            unitNumber = `${unitNumber}-${current.reference}`;
          }
          unit = await tx.unit.create({
            data: {
              projectId: ctx.projectId,
              number: unitNumber,
              type: 'PLOT',
              size: decimal('1'),
              measurementUnit: 'Unit',
              price: input.askingPrice,
              status: 'AVAILABLE',
              phase: current.location || null,
            },
          });
          await tx.propertyPurchase.update({
            where: { id: current.id },
            data: { unitId: unit.id },
          });
          await unitState(tx, ctx, unit.id, 'AVAILABLE', 'Acquired property listed for sale');
        }

        await audit(tx, ctx, 'purchase.listed_for_sale', current.id, {
          unitId: unit.id,
          askingPrice: input.askingPrice,
        });
        return { purchase: current, unit };
      }),
  );
}
