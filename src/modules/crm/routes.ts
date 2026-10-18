import type { Express } from 'express';
import { z } from 'zod';
import { db, transaction, type Tx } from '../../database/client.js';
import { endpoint, pageQuery, pagination, paged, uuid, id } from '../../common/http.js';
import { positiveMoney } from '../../common/money.js';
import { found } from '../../common/errors.js';
import { scopedBooking } from '../sales/service.js';
import { assignmentEmail } from '../../common/notifications.js';
const root = '/projects/:projectId';
async function requireAssignee(tx: Tx, userId: string, projectId: string) {
  found(
    await tx.userProjectAccess.findFirst({
      where: { userId, projectId, user: { active: true, accountType: 'STAFF' } },
    }),
  );
}
export function crmRoutes(app: Express) {
  endpoint(
    app,
    'post',
    root + '/recovery-cases',
    {
      permission: 'recovery.manage',
      summary: 'Assign recovery case to an authorized project user',
      body: z.object({ bookingId: uuid, assignedTo: uuid }).strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const booking = await scopedBooking(tx, ctx, b.bookingId);
        await requireAssignee(tx, b.assignedTo, ctx.projectId);
        const recovery = await tx.recoveryCase.create({ data: b });
        await assignmentEmail(
          tx,
          b.assignedTo,
          ctx.projectId,
          'New recovery case assigned to you',
          `You have been assigned a recovery case for booking ${booking.reference}.`,
        );
        return recovery;
      }),
  );
  endpoint(
    app,
    'get',
    root + '/recovery-cases',
    {
      permission: 'recovery.manage',
      summary: 'List recovery case history',
      query: pageQuery.extend({ assignedTo: uuid.optional() }),
    },
    async (ctx, _b, q) => {
      const where = { booking: { unit: { projectId: ctx.projectId } }, assignedTo: q.assignedTo };
      const [items, total] = await Promise.all([
        db.recoveryCase.findMany({
          where,
          ...pagination(q),
          include: {
            activities: true,
            booking: { select: { reference: true, customer: { select: { name: true } } } },
          },
          orderBy: { createdAt: q.sort },
        }),
        db.recoveryCase.count({ where }),
      ]);
      const employees = await db.user.findMany({
        where: { id: { in: items.map((r) => r.assignedTo) }, accountType: 'STAFF' },
        select: { id: true, name: true },
      });
      return paged(
        items.map((r) => ({
          ...r,
          employee: employees.find((u) => u.id === r.assignedTo)?.name ?? 'Employee',
        })),
        total,
        q,
      );
    },
  );
  endpoint(
    app,
    'post',
    root + '/recovery-cases/:id/activities',
    {
      permission: 'recovery.manage',
      summary: 'Log recovery contact, promise to pay or escalation',
      body: z
        .object({
          kind: z.enum(['CALL', 'NOTICE', 'PROMISE_TO_PAY', 'ESCALATION', 'NOTE']),
          notes: z.string().min(1).max(4000),
          promiseAmount: positiveMoney.optional(),
          promiseDate: z.iso.date().optional(),
        })
        .strict()
        .refine(
          (b) => b.kind !== 'PROMISE_TO_PAY' || (b.promiseAmount && b.promiseDate),
          'A promise requires amount and date',
        ),
    },
    async (ctx, b, _q, req) => {
      found(
        await db.recoveryCase.findFirst({
          where: { id: id(req), booking: { unit: { projectId: ctx.projectId } } },
        }),
      );
      return db.recoveryActivity.create({
        data: {
          ...b,
          promiseDate: b.promiseDate ? new Date(b.promiseDate) : undefined,
          caseId: id(req),
          createdBy: ctx.actor.id,
        },
      });
    },
  );
  endpoint(
    app,
    'patch',
    root + '/recovery-cases/:id',
    {
      permission: 'recovery.manage',
      summary: 'Close or reopen recovery case',
      body: z.object({ status: z.enum(['OPEN', 'CLOSED']) }).strict(),
    },
    async (ctx, b, _q, req) => {
      found(
        await db.recoveryCase.findFirst({
          where: { id: id(req), booking: { unit: { projectId: ctx.projectId } } },
        }),
      );
      return db.recoveryCase.update({ where: { id: id(req) }, data: b });
    },
  );
}
