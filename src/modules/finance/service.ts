import { Prisma } from '@prisma/client';
import { lock, type Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { decimal, sum } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit, reference } from '../../common/operations.js';
export type PostingLine = {
  accountId: string;
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
  vendorId?: string | null;
};
export async function mappedAccount(tx: Tx, projectId: string, event: string) {
  const setting = found(
    await tx.projectSetting.findUnique({
      where: { projectId_key: { projectId, key: 'accounting' } },
    }),
  );
  const mapping = setting.value as Record<string, string>;
  return found(mapping[event]);
}
export async function postJournal(
  tx: Tx,
  ctx: Context,
  input: {
    source: string;
    sourceId: string;
    description: string;
    lines: PostingLine[];
    postedAt?: Date;
    reversalOfId?: string;
  },
) {
  requireState(
    input.lines.length >= 2,
    'INVALID_JOURNAL',
    'At least two journal lines are required.',
    422,
  );
  const debit = sum(input.lines.map((l) => l.debit));
  const credit = sum(input.lines.map((l) => l.credit));
  requireState(
    debit.gt(0) && debit.eq(credit),
    'UNBALANCED_JOURNAL',
    'Journal debits and credits must balance exactly.',
    422,
  );
  for (const line of input.lines)
    requireState(
      decimal(line.debit).gte(0) &&
        decimal(line.credit).gte(0) &&
        decimal(line.debit).gt(0) !== decimal(line.credit).gt(0),
      'INVALID_JOURNAL_LINE',
      'Each line must have exactly one positive side.',
      422,
    );
  const accounts = [...new Set(input.lines.map((l) => l.accountId))];
  requireState(
    (await tx.account.count({
      where: { id: { in: accounts }, projectId: ctx.projectId, active: true },
    })) === accounts.length,
    'INVALID_ACCOUNT',
    'All accounts must be active in this project.',
    422,
  );
  const vendors = [...new Set(input.lines.flatMap((l) => (l.vendorId ? [l.vendorId] : [])))];
  requireState(
    (await tx.vendor.count({ where: { id: { in: vendors }, projectId: ctx.projectId } })) ===
      vendors.length,
    'INVALID_VENDOR',
    'Vendor references must belong to this project.',
    422,
  );
  const postedAt = input.postedAt ?? new Date();
  const day = new Date(postedAt.toISOString().slice(0, 10));
  const periods = await tx.accountingPeriod.findMany({
    where: { projectId: ctx.projectId, startDate: { lte: day }, endDate: { gte: day } },
  });
  requireState(
    periods.length === 1,
    'ACCOUNTING_PERIOD_REQUIRED',
    'Exactly one accounting period must contain the posting date.',
    422,
  );
  await lock(tx, 'AccountingPeriod', periods[0]!.id);
  const period = found(await tx.accountingPeriod.findUnique({ where: { id: periods[0]!.id } }));
  requireState(!period.locked, 'ACCOUNTING_PERIOD_CLOSED', 'This accounting period is locked.');
  const journal = await tx.journal.create({
    data: {
      projectId: ctx.projectId,
      periodId: period.id,
      reference: await reference(tx, 'JV'),
      source: input.source,
      sourceId: input.sourceId,
      description: input.description,
      postedAt,
      createdBy: ctx.actor.id,
      reversalOfId: input.reversalOfId,
      lines: {
        create: input.lines.map((l) => ({
          accountId: l.accountId,
          vendorId: l.vendorId,
          debit: decimal(l.debit),
          credit: decimal(l.credit),
        })),
      },
    },
    include: { lines: true },
  });
  await audit(tx, ctx, 'finance.posted', journal.id, {
    source: input.source,
    debit: debit.toFixed(2),
  });
  return journal;
}
export async function reverseJournal(tx: Tx, ctx: Context, journalId: string, reason: string) {
  const journal = found(
    await tx.journal.findFirst({
      where: { id: journalId, projectId: ctx.projectId },
      include: { lines: true, reversal: true },
    }),
  );
  requireState(
    !journal.reversal && !journal.reversalOfId,
    'ALREADY_REVERSED',
    'This journal cannot be reversed again.',
  );
  return postJournal(tx, ctx, {
    source: 'REVERSAL',
    sourceId: journal.id,
    reversalOfId: journal.id,
    description: reason,
    lines: journal.lines.map((l) => ({
      accountId: l.accountId,
      vendorId: l.vendorId,
      debit: l.credit,
      credit: l.debit,
    })),
  });
}
export async function defaultAccounts(tx: Tx, projectId: string) {
  const definitions = [
    ['1000', 'Cash and bank', 'ASSET', 'cash'],
    ['2000', 'Customer advances', 'LIABILITY', 'advances'],
    ['2100', 'Dealer payable', 'LIABILITY', 'dealerPayable'],
    ['4000', 'Cancellation deductions', 'REVENUE', 'deductions'],
    ['4100', 'Transfer services', 'REVENUE', 'transferRevenue'],
    ['5000', 'Dealer commission expense', 'EXPENSE', 'commissionExpense'],
    ['1200', 'Dealer commission recoverable', 'ASSET', 'dealerRecoverable'],
  ] as const;
  const mapping: Record<string, string> = {};
  for (const [code, name, type, key] of definitions) {
    const account = await tx.account.create({ data: { projectId, code, name, type } });
    mapping[key] = account.id;
  }
  await tx.projectSetting.create({ data: { projectId, key: 'accounting', value: mapping } });
  const year = new Date().getUTCFullYear();
  await tx.accountingPeriod.create({
    data: { projectId, startDate: new Date(`${year}-01-01`), endDate: new Date(`${year}-12-31`) },
  });
}
