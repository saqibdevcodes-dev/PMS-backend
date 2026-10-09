import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db, transaction, type Tx } from '../database/client.js';
import { env } from '../config/env.js';
import { outbox } from '../common/operations.js';
import { sum } from '../common/money.js';
async function eventCustomer(tx: Tx, kind: string, entityId: string) {
  if (kind === 'Booking confirmed')
    return (await tx.booking.findUnique({ where: { id: entityId }, include: { customer: true } }))
      ?.customer;
  if (kind === 'Payment receipt')
    return (await tx.payment.findUnique({ where: { id: entityId }, include: { payer: true } }))
      ?.payer;
  if (kind === 'NDC issued')
    return (
      await tx.ndc.findUnique({
        where: { id: entityId },
        include: { booking: { include: { customer: true } } },
      })
    )?.booking.customer;
  if (kind === 'Possession completed')
    return (
      await tx.possession.findUnique({
        where: { id: entityId },
        include: { booking: { include: { customer: true } } },
      })
    )?.booking.customer;
  if (kind === 'Ownership transferred')
    return (await tx.transfer.findUnique({ where: { id: entityId }, include: { buyer: true } }))
      ?.buyer;
  if (['Upcoming installment', 'Overdue installment'].includes(kind))
    return (
      await tx.installment.findUnique({
        where: { id: entityId },
        include: { booking: { include: { customer: true } } },
      })
    )?.booking.customer;
}
export async function businessEvent(event: { id: string; payload: Prisma.JsonValue }) {
  const input = z
    .object({ projectId: z.uuid(), kind: z.string(), entityId: z.string() })
    .parse(event.payload);
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Outbox" WHERE id=${event.id}::uuid FOR UPDATE`;
    const current = await tx.outbox.findUniqueOrThrow({ where: { id: event.id } });
    if (current.processedAt) return;
    const users = await tx.userProjectAccess.findMany({
      where: { projectId: input.projectId, user: { active: true } },
      include: { user: { select: { devices: { select: { pushToken: true } } } } },
    });
    for (const user of users) {
      const channels =
        env.PUSH_WEBHOOK_URL && user.user.devices.some((d) => d.pushToken)
          ? ['IN_APP', 'PUSH']
          : ['IN_APP'];
      for (const channel of channels) {
        const n = await tx.notification.create({
          data: {
            userId: user.userId,
            title: input.kind,
            body: 'A project record was updated. Open PMS to review it.',
            channel,
          },
        });
        await outbox(tx, 'notification', { notificationId: n.id });
      }
    }
    const customer = await eventCustomer(tx, input.kind, input.entityId);
    if (customer) {
      await tx.notification.create({
        data: {
          customerId: customer.id,
          title: input.kind,
          body: 'Your property account has an update. Open your customer portal to view it.',
          channel: 'IN_APP',
        },
      });
    }
    if (customer?.communicationConsent) {
      const channels: { channel: string; recipient: string }[] = [];
      if (customer.email) channels.push({ channel: 'EMAIL', recipient: customer.email });
      if (env.SMS_WEBHOOK_URL && customer.phone)
        channels.push({ channel: 'SMS', recipient: customer.phone });
      for (const channel of channels) {
        const n = await tx.notification.create({
          data: {
            customerId: customer.id,
            title: input.kind,
            body: 'Your property account has an update. Please contact the project office or sign in to view it.',
            ...channel,
          },
        });
        await outbox(tx, 'notification', { notificationId: n.id });
      }
    }
    await tx.outbox.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  });
}
export async function scheduleReminders() {
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.installment.findMany({
      where: {
        superseded: false,
        dueDate: { lte: new Date(Date.now() + 8 * 86400000) },
        booking: { status: 'CONFIRMED' },
      },
      include: {
        allocations: { where: { reversedAt: null } },
        booking: { include: { unit: { include: { project: true } } } },
      },
      orderBy: { id: 'asc' },
      take: 250,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const row of rows) {
      if (sum(row.allocations.map((a) => a.amount)).gte(row.amount)) continue;
      const project = row.booking.unit.project;
      const today = DateTime.now().setZone(project.timezone).startOf('day');
      const due = DateTime.fromISO(row.dueDate.toISOString().slice(0, 10), {
        zone: project.timezone,
      });
      if (due > today.plus({ days: 7 })) continue;
      await transaction(async (tx) => {
        const key = `${row.id}-${today.toISODate()}`;
        const record = await tx.idempotencyRecord.createMany({
          data: [
            {
              key,
              actorId: row.booking.createdBy,
              operation: 'installment-reminder',
              requestHash: row.id,
              response: { queued: true },
            },
          ],
          skipDuplicates: true,
        });
        if (!record.count) return;
        await outbox(tx, 'business-event', {
          projectId: project.id,
          kind:
            due.plus({ days: project.graceDays }) < today
              ? 'Overdue installment'
              : 'Upcoming installment',
          entityId: row.id,
        });
      });
    }
    cursor = rows.at(-1)!.id;
  }
}
