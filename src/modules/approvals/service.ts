import { db, lock, transaction, type Tx } from '../../database/client.js';
import { decimal } from '../../common/money.js';
import { audit, json } from '../../common/operations.js';
import { canonical } from '../../common/security.js';
import { found, requireState } from '../../common/errors.js';
import type { Context } from '../../common/context.js';
export const approvalPermissions = {
  DISCOUNT: 'discounts.approve',
  BOOKING: 'bookings.approve',
  PRICE: 'inventory.change_price',
  RESCHEDULE: 'bookings.approve',
  PAYMENT_REVERSAL: 'payments.reverse',
  NDC: 'ndc.approve',
  TRANSFER: 'transfers.approve',
  CANCELLATION: 'bookings.cancel',
  REFUND: 'refunds.approve',
  COMMISSION: 'commissions.approve',
  POSSESSION: 'possession.approve',
  JOURNAL: 'finance.post',
} as const;
export type Operation = keyof typeof approvalPermissions;
export async function requestApproval(
  tx: Tx,
  ctx: Context,
  operation: Operation,
  entityId: string,
  amount: string,
  payload: unknown = {},
) {
  const policy = await tx.approvalPolicy.findFirst({
    where: { projectId: ctx.projectId, operation, minimumAmount: { lte: decimal(amount) } },
    orderBy: { minimumAmount: 'desc' },
  });
  const approval = await tx.approval.create({
    data: {
      projectId: ctx.projectId,
      operation,
      entityId,
      amount: decimal(amount),
      payload: json(payload),
      requestedBy: ctx.actor.id,
      permissions: policy?.permissions ?? [approvalPermissions[operation]],
    },
  });
  await audit(tx, ctx, 'approval.requested', approval.id, { operation, entityId });
  return approval;
}
export async function decide(
  ctx: Context,
  id: string,
  decision: 'APPROVE' | 'REJECT',
  comment: string,
) {
  return transaction(async (tx) => {
    await lock(tx, 'Approval', id);
    const approval = found(
      await tx.approval.findFirst({ where: { id, projectId: ctx.projectId } }),
    );
    requireState(
      approval.status === 'PENDING',
      'APPROVAL_CLOSED',
      'This approval is no longer pending.',
    );
    requireState(
      approval.requestedBy !== ctx.actor.id,
      'SELF_APPROVAL_FORBIDDEN',
      'A different user must approve this request.',
      403,
    );
    requireState(
      ctx.actor.permissions.has(approval.permissions[approval.level]!),
      'FORBIDDEN',
      'You cannot approve this level.',
      403,
    );
    // A different approver is required for each configured level.
    requireState(
      !(await tx.approvalAction.findFirst({ where: { approvalId: id, actorId: ctx.actor.id } })),
      'DUPLICATE_APPROVER',
      'This user has already acted on the request.',
      403,
    );
    await tx.approvalAction.create({
      data: { approvalId: id, actorId: ctx.actor.id, level: approval.level, decision, comment },
    });
    const status =
      decision === 'REJECT'
        ? 'REJECTED'
        : approval.level + 1 === approval.permissions.length
          ? 'APPROVED'
          : 'PENDING';
    const result = await tx.approval.update({
      where: { id },
      data: { status, level: approval.level + 1 },
    });
    await audit(tx, ctx, 'approval.decided', id, { decision, level: approval.level });
    return result;
  });
}
export async function consume(
  tx: Tx,
  ctx: Context,
  id: string,
  operation: Operation,
  entityId: string,
  payload?: unknown,
) {
  await lock(tx, 'Approval', id);
  const approval = found(
    await tx.approval.findFirst({ where: { id, projectId: ctx.projectId, operation, entityId } }),
  );
  requireState(
    approval.status === 'APPROVED',
    'APPROVAL_REQUIRED',
    'An approved request is required.',
  );
  if (payload !== undefined)
    requireState(
      canonical(approval.payload) === canonical(payload),
      'APPROVAL_DATA_CHANGED',
      'The operation does not match the approved request.',
    );
  await tx.approval.update({ where: { id }, data: { status: 'CONSUMED' } });
  return approval;
}
export const approvalList = (projectId: string) =>
  db.approval.findMany({
    where: { projectId },
    include: { actions: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
