import { deliverInvitation } from '../modules/portal/invitations.js';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import pino from 'pino';
import { env } from '../config/env.js';
import { db } from '../database/client.js';
import { businessEvent, scheduleReminders } from './events.js';
import { decrypt } from '../common/security.js';
import { generateArtifact } from './artifacts.js';
import { deliverNotification, sendEmail } from '../integrations/notifications.js';
import { expireReservations } from '../modules/sales/service.js';
import { ensureStorage, storage } from '../integrations/storage.js';
import { redis } from '../integrations/redis.js';
const logger = pino();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const queue = new Queue(env.NODE_ENV === 'test' ? 'pms-events-test' : 'pms-events', {
  connection,
});
const worker = new Worker(
  env.NODE_ENV === 'test' ? 'pms-events-test' : 'pms-events',
  async (job) => {
    if (job.name === 'maintenance') {
      await expireReservations();
      await scheduleReminders();
      return;
    }
    const event = await db.outbox.findUniqueOrThrow({ where: { id: job.id! } });
    if (event.processedAt) return;
    if (event.kind === 'export' || event.kind === 'document')
      await generateArtifact(z.object({ jobId: z.uuid() }).parse(event.payload).jobId);
    else if (event.kind === 'password-reset') {
      const input = z.object({ userId: z.uuid(), encryptedToken: z.string() }).parse(event.payload);
      const user = await db.user.findUniqueOrThrow({ where: { id: input.userId } });
      await sendEmail(
        user.email,
        'Reset your PMS password',
        `Your one-time reset token is ${decrypt(input.encryptedToken)}. Enter it in the password reset screen. It expires in 30 minutes.`,
        event.id,
      );
    } else if (event.kind === 'customer-invitation') {
      const input = z
        .object({ invitationId: z.uuid(), encryptedToken: z.string() })
        .parse(event.payload);
      await deliverInvitation(input.invitationId, input.encryptedToken, event.id);
    } else if (event.kind === 'notification') {
      await deliverNotification(
        z.object({ notificationId: z.uuid() }).parse(event.payload).notificationId,
      );
    } else if (event.kind === 'business-event') {
      await businessEvent(event);
    } else throw new Error('Unrecognized outbox event');
    await db.outbox.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  },
  { connection, concurrency: 4 },
);
worker.on('failed', (job, error) =>
  logger.error({ jobId: job?.id, error: error.message }, 'Background delivery failed'),
);
async function dispatch() {
  const events = await db.outbox.findMany({
    where: { dispatchedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const event of events) {
    await queue.add(
      event.kind,
      {},
      {
        jobId: event.id,
        attempts: 8,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    await db.outbox.update({ where: { id: event.id }, data: { dispatchedAt: new Date() } });
  }
}
await ensureStorage();
await queue.upsertJobScheduler(
  'pms-maintenance',
  { every: 60000 },
  {
    name: 'maintenance',
    data: {},
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  },
);
let dispatching = false;
const timer = setInterval(() => {
  if (dispatching) return;
  dispatching = true;
  dispatch()
    .catch((error) => logger.error({ error: String(error) }, 'Outbox dispatch failed'))
    .finally(() => {
      dispatching = false;
    });
}, 1000);
async function shutdown() {
  clearInterval(timer);
  await worker.close();
  await queue.close();
  await connection.quit();
  await redis.quit();
  await db.$disconnect();
  storage.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
logger.info('PMS worker ready');
