import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccountType } from '@prisma/client';
import { db, transaction, lock } from '../../database/client.js';
import {
  endpoint,
  uuid,
  id,
  pageQuery,
  paginationQuery,
  paged,
  pagination,
} from '../../common/http.js';
import { money, sum } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit, json } from '../../common/operations.js';
import { postJournal, reverseJournal } from './service.js';
import { requestApproval, consume } from '../approvals/service.js';
const root = '/projects/:projectId';
const journalBody = z
  .object({
    description: z.string().min(3).max(1000),
    postedAt: z.iso.datetime(),
    lines: z
      .array(
        z
          .object({ accountId: uuid, debit: money, credit: money, vendorId: uuid.optional() })
          .strict(),
      )
      .min(2)
      .max(100),
  })
  .strict();
export function financeRoutes(app: Express) {
  endpoint(
    app,
    'get',
    root + '/accounts',
    { permission: 'finance.read', summary: 'List chart of accounts' },
    async (ctx) =>
      db.account.findMany({ where: { projectId: ctx.projectId }, orderBy: { code: 'asc' } }),
  );
  endpoint(
    app,
    'post',
    root + '/accounts',
    {
      permission: 'finance.post',
      summary: 'Add chart of account entry',
      body: z
        .object({
          code: z.string().min(1).max(20),
          name: z.string().min(2).max(200),
          type: z.enum(AccountType),
        })
        .strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const account = await tx.account.create({ data: { ...b, projectId: ctx.projectId } });
        await audit(tx, ctx, 'account.created', account.id);
        return account;
      }),
  );
  endpoint(
    app,
    'get',
    root + '/accounting-periods',
    { permission: 'finance.read', summary: 'List accounting periods and locks' },
    async (ctx) =>
      db.accountingPeriod.findMany({
        where: { projectId: ctx.projectId },
        orderBy: { startDate: 'asc' },
      }),
  );
  endpoint(
    app,
    'post',
    root + '/accounting-periods',
    {
      permission: 'finance.post',
      summary: 'Create a non-overlapping accounting period',
      body: z
        .object({ startDate: z.iso.date(), endDate: z.iso.date() })
        .strict()
        .refine((b) => b.startDate <= b.endDate),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        await lock(tx, 'Project', ctx.projectId);
        requireState(
          !(await tx.accountingPeriod.findFirst({
            where: {
              projectId: ctx.projectId,
              startDate: { lte: new Date(b.endDate) },
              endDate: { gte: new Date(b.startDate) },
            },
          })),
          'PERIOD_OVERLAP',
          'Accounting periods must not overlap.',
        );
        return tx.accountingPeriod.create({
          data: {
            projectId: ctx.projectId,
            startDate: new Date(b.startDate),
            endDate: new Date(b.endDate),
          },
        });
      }),
  );
  endpoint(
    app,
    'post',
    root + '/accounting-periods/:id/lock',
    { permission: 'finance.post', summary: 'Permanently close an accounting period' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'AccountingPeriod', id(req));
        found(
          await tx.accountingPeriod.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        const result = await tx.accountingPeriod.update({
          where: { id: id(req) },
          data: { locked: true },
        });
        await audit(tx, ctx, 'period.locked', id(req));
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/journals/requests',
    {
      permission: 'finance.post',
      summary: 'Request approval of a manual balanced journal',
      body: journalBody,
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        requireState(
          sum(b.lines.map((l) => l.debit)).eq(sum(b.lines.map((l) => l.credit))),
          'UNBALANCED_JOURNAL',
          'Debits and credits must balance.',
          422,
        );
        return requestApproval(
          tx,
          ctx,
          'JOURNAL',
          randomUUID(),
          sum(b.lines.map((l) => l.debit)).toFixed(2),
          b,
        );
      }),
  );
  endpoint(
    app,
    'post',
    root + '/journals',
    {
      permission: 'finance.post',
      summary: 'Post approved manual journal; immutable after posting',
      body: journalBody.extend({ approvalId: uuid }),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const approval = found(
          await tx.approval.findFirst({
            where: { id: b.approvalId, projectId: ctx.projectId, operation: 'JOURNAL' },
          }),
        );
        const { approvalId, ...payload } = b;
        await consume(tx, ctx, approvalId, 'JOURNAL', approval.entityId, payload);
        return postJournal(tx, ctx, {
          source: 'MANUAL',
          sourceId: approval.entityId,
          description: b.description,
          postedAt: new Date(b.postedAt),
          lines: b.lines,
        });
      }),
  );
  endpoint(
    app,
    'get',
    root + '/journals',
    { permission: 'finance.read', summary: 'List immutable journals and lines', query: pageQuery },
    async (ctx, _b, q) => {
      const where = { projectId: ctx.projectId };
      const [items, total] = await Promise.all([
        db.journal.findMany({
          where,
          ...pagination(q),
          include: { lines: true },
          orderBy: { postedAt: q.sort },
        }),
        db.journal.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/journals/:id/reverse',
    {
      permission: 'finance.reverse',
      summary: 'Reverse a manual journal in the current open period',
      body: z.object({ reason: z.string().min(3).max(1000) }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const journal = found(
          await tx.journal.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        requireState(
          journal.source === 'MANUAL',
          'DOMAIN_REVERSAL_REQUIRED',
          'Operational journals must be reversed through their business workflow.',
        );
        return reverseJournal(tx, ctx, journal.id, b.reason);
      }),
  );
  endpoint(
    app,
    'get',
    root + '/settings',
    { permission: 'settings.manage', summary: 'Read project configuration' },
    async (ctx) => db.projectSetting.findMany({ where: { projectId: ctx.projectId } }),
  );
  endpoint(
    app,
    'post',
    root + '/settings/accounting',
    {
      permission: 'settings.manage',
      summary: 'Configure account mappings for operational events',
      body: z
        .object({
          cash: uuid,
          advances: uuid,
          dealerPayable: uuid,
          deductions: uuid,
          transferRevenue: uuid,
          commissionExpense: uuid,
          dealerRecoverable: uuid,
        })
        .strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const expected = {
          cash: 'ASSET',
          advances: 'LIABILITY',
          dealerPayable: 'LIABILITY',
          deductions: 'REVENUE',
          transferRevenue: 'REVENUE',
          commissionExpense: 'EXPENSE',
          dealerRecoverable: 'ASSET',
        } as const;
        for (const key of Object.keys(expected) as (keyof typeof expected)[])
          found(
            await tx.account.findFirst({
              where: { id: b[key], projectId: ctx.projectId, active: true, type: expected[key] },
            }),
          );
        const result = await tx.projectSetting.upsert({
          where: { projectId_key: { projectId: ctx.projectId, key: 'accounting' } },
          create: { projectId: ctx.projectId, key: 'accounting', value: json(b) },
          update: { value: json(b) },
        });
        await audit(tx, ctx, 'accounting.mapping_changed', ctx.projectId, b);
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/bank-accounts',
    {
      permission: 'finance.post',
      summary: 'Register bank account against an asset ledger',
      body: z
        .object({
          accountId: uuid,
          name: z.string().min(2).max(200),
          iban: z.string().min(8).max(40),
        })
        .strict(),
    },
    async (ctx, b) => {
      found(
        await db.account.findFirst({
          where: { id: b.accountId, projectId: ctx.projectId, type: 'ASSET' },
        }),
      );
      return db.bankAccount.create({ data: { ...b, projectId: ctx.projectId } });
    },
  );
  endpoint(
    app,
    'get',
    root + '/bank-accounts',
    { permission: 'finance.read', summary: 'List registered bank accounts' },
    async (ctx) => db.bankAccount.findMany({ where: { projectId: ctx.projectId } }),
  );
  endpoint(
    app,
    'post',
    root + '/bank-accounts/:id/reconcile',
    {
      permission: 'finance.post',
      summary: 'Match a posted bank ledger line to a statement',
      body: z
        .object({
          journalLineId: uuid,
          statementReference: z.string().min(1).max(200),
          statementDate: z.iso.date(),
        })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const bank = found(
          await tx.bankAccount.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        found(
          await tx.journalLine.findFirst({
            where: {
              id: b.journalLineId,
              accountId: bank.accountId,
              journal: { projectId: ctx.projectId },
            },
          }),
        );
        return tx.bankReconciliation.create({
          data: {
            ...b,
            statementDate: new Date(b.statementDate),
            bankAccountId: bank.id,
            reconciledBy: ctx.actor.id,
          },
        });
      }),
  );
  endpoint(
    app,
    'post',
    root + '/vendors',
    {
      permission: 'finance.post',
      summary: 'Register project vendor',
      body: z
        .object({ name: z.string().min(2).max(200), phone: z.string().min(6).max(30) })
        .strict(),
    },
    async (ctx, b) => db.vendor.create({ data: { ...b, projectId: ctx.projectId } }),
  );
  endpoint(
    app,
    'get',
    root + '/vendors',
    {
      permission: 'finance.read',
      summary: 'List project vendors',
      query: paginationQuery.extend({ search: z.string().max(200).optional() }),
    },
    async (ctx, _b, q) => {
      const where = {
        projectId: ctx.projectId,
        ...(q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
      };
      const [items, total] = await Promise.all([
        db.vendor.findMany({
          where,
          ...pagination(q),
          orderBy: [{ name: q.sort }, { id: q.sort }],
        }),
        db.vendor.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    root + '/audit',
    { permission: 'audit.read', summary: 'Read append-only project audit trail', query: pageQuery },
    async (ctx, _b, q) => {
      const where = { projectId: ctx.projectId };
      const [items, total] = await Promise.all([
        db.auditLog.findMany({ where, ...pagination(q), orderBy: { createdAt: q.sort } }),
        db.auditLog.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
}
