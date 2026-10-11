import { requireImage } from '../images/service.js';
import type { Express } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db, transaction, lock, type Tx } from '../../database/client.js';
import { endpoint, pageQuery, pagination, paged, uuid, id } from '../../common/http.js';
import { money, positiveMoney, decimal } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
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
  const leadBody = z
    .object({
      name: z.string().min(2).max(200),
      phone: z.string().min(6).max(30),
      source: z.string().min(1).max(100),
      assignedTo: uuid.optional(),
      dealerId: uuid.optional(),
    })
    .strict();
  endpoint(
    app,
    'post',
    root + '/leads',
    {
      permission: 'crm.manage',
      summary: 'Register a lead with project-scoped assignment',
      body: leadBody,
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        if (b.assignedTo) await requireAssignee(tx, b.assignedTo, ctx.projectId);
        if (b.dealerId)
          found(
            await tx.dealer.findFirst({
              where: { id: b.dealerId, projectId: ctx.projectId, active: true },
            }),
          );
        const lead = await tx.lead.create({ data: { ...b, projectId: ctx.projectId } });
        await audit(tx, ctx, 'lead.created', lead.id);
        if (lead.assignedTo)
          await assignmentEmail(
            tx,
            lead.assignedTo,
            ctx.projectId,
            'New lead assigned to you',
            `You have been assigned a lead: ${lead.name}.`,
          );
        return lead;
      }),
  );
  endpoint(
    app,
    'get',
    root + '/leads',
    {
      permission: 'crm.read',
      summary: 'Search leads and activities',
      query: pageQuery.extend({
        status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'LOST', 'CONVERTED']).optional(),
        assignedTo: uuid.optional(),
      }),
    },
    async (ctx, _b, q) => {
      const where: Prisma.LeadWhereInput = {
        projectId: ctx.projectId,
        status: q.status,
        assignedTo: q.assignedTo,
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { phone: { contains: q.search } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.lead.findMany({
          where,
          ...pagination(q),
          orderBy: { createdAt: q.sort },
          include: { activities: { orderBy: { createdAt: 'desc' }, take: 10 } },
        }),
        db.lead.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'patch',
    root + '/leads/:id',
    {
      permission: 'crm.manage',
      summary: 'Update lead stage or assignee',
      body: z
        .object({
          status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'LOST']).optional(),
          assignedTo: uuid.optional(),
        })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'Lead', id(req));
        const lead = found(
          await tx.lead.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        requireState(
          lead.status !== 'CONVERTED',
          'LEAD_CONVERTED',
          'Converted leads retain their customer linkage.',
        );
        if (b.assignedTo) await requireAssignee(tx, b.assignedTo, ctx.projectId);
        const updated = await tx.lead.update({ where: { id: lead.id }, data: b });
        if (b.assignedTo && b.assignedTo !== lead.assignedTo)
          await assignmentEmail(
            tx,
            b.assignedTo,
            ctx.projectId,
            'Lead reassigned to you',
            `You have been assigned a lead: ${lead.name}.`,
          );
        return updated;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/leads/:id/activities',
    {
      permission: 'crm.manage',
      summary: 'Record call, follow-up, site visit, meeting or quotation',
      body: z
        .object({
          kind: z.enum(['CALL', 'MEETING', 'FOLLOW_UP', 'SITE_VISIT', 'QUOTATION', 'NOTE']),
          notes: z.string().min(1).max(4000),
          scheduledAt: z.iso.datetime().optional(),
          amount: positiveMoney.optional(),
        })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const lead = found(
          await tx.lead.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        const activity = await tx.leadActivity.create({
          data: {
            ...b,
            scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : undefined,
            leadId: id(req),
            createdBy: ctx.actor.id,
          },
        });
        if (b.scheduledAt && lead.assignedTo) {
          await requireAssignee(tx, lead.assignedTo, ctx.projectId);
          await assignmentEmail(
            tx,
            lead.assignedTo,
            ctx.projectId,
            'New scheduled lead activity',
            `A ${b.kind.toLowerCase().replaceAll('_', ' ')} has been scheduled for your lead ${lead.name}.\nScheduled time: ${new Date(b.scheduledAt).toISOString()} (UTC).`,
          );
        }
        return activity;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/leads/:id/convert',
    {
      permission: 'crm.manage',
      summary: 'Link qualified lead to an existing project customer',
      body: z.object({ customerId: uuid }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const lead = found(
          await tx.lead.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        requireState(
          lead.status === 'QUALIFIED',
          'LEAD_NOT_QUALIFIED',
          'Qualify the lead before conversion.',
        );
        found(
          await tx.customer.findFirst({ where: { id: b.customerId, projectId: ctx.projectId } }),
        );
        const result = await tx.lead.update({
          where: { id: lead.id },
          data: { status: 'CONVERTED', customerId: b.customerId },
        });
        await audit(tx, ctx, 'lead.converted', lead.id);
        return result;
      }),
  );
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
          include: { activities: true },
          orderBy: { createdAt: q.sort },
        }),
        db.recoveryCase.count({ where }),
      ]);
      return paged(items, total, q);
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
  endpoint(
    app,
    'post',
    root + '/dealers',
    {
      permission: 'dealers.manage',
      summary: 'Register dealer project assignment and commission rule',
      body: z
        .object({
          name: z.string().min(2).max(200),
          phone: z.string().min(6).max(30),
          photoId: uuid,
          commissionPercent: money.refine((v) => decimal(v).lte(100)).default('0'),
        })
        .strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        await requireImage(tx, ctx, b.photoId, 'DEALER');
        const dealer = await tx.dealer.create({ data: { ...b, projectId: ctx.projectId } });
        await audit(tx, ctx, 'dealer.created', dealer.id);
        return dealer;
      }),
  );
  endpoint(
    app,
    'get',
    root + '/dealers',
    {
      permission: 'dealers.read',
      summary: 'List project dealers and commissions',
      query: pageQuery,
    },
    async (ctx, _b, q) => {
      const where = { projectId: ctx.projectId };
      const [items, total] = await Promise.all([
        db.dealer.findMany({ where, ...pagination(q), orderBy: { createdAt: q.sort } }),
        db.dealer.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    root + '/dealers/:id',
    {
      permission: 'dealers.read',
      summary: 'Dealer statement with sales, allocations and commissions',
    },
    async (ctx, _b, _q, req) =>
      found(
        await db.dealer.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          include: {
            allocations: true,
            commissions: true,
            bookings: { select: { id: true, reference: true, total: true, status: true } },
          },
        }),
      ),
  );
  endpoint(
    app,
    'post',
    root + '/dealers/:id/allocations',
    {
      permission: 'dealers.manage',
      summary: 'Assign inventory to dealer without bypassing central reservation rules',
      body: z.object({ unitId: uuid, expiresAt: z.iso.datetime() }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        found(
          await tx.dealer.findFirst({
            where: { id: id(req), projectId: ctx.projectId, active: true },
          }),
        );
        found(await tx.unit.findFirst({ where: { id: b.unitId, projectId: ctx.projectId } }));
        return tx.dealerAllocation.upsert({
          where: { dealerId_unitId: { dealerId: id(req), unitId: b.unitId } },
          create: { dealerId: id(req), unitId: b.unitId, expiresAt: new Date(b.expiresAt) },
          update: { expiresAt: new Date(b.expiresAt) },
        });
      }),
  );
}
