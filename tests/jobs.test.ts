import { beforeAll, afterAll, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db, transaction } from '../src/database/client.js';
import { outbox } from '../src/common/operations.js';
import { ensureStorage, storage } from '../src/integrations/storage.js';
import { redis } from '../src/integrations/redis.js';
let worker: ChildProcess;
let workerLogs = '';
let userId: string;
let projectId: string;
async function eventually(check: () => Promise<boolean>, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Worker did not finish in time: ' + workerLogs.slice(-1500));
}
beforeAll(async () => {
  await ensureStorage();
  const permission = await db.permission.upsert({
    where: { key: 'reports.export' },
    create: { key: 'reports.export' },
    update: {},
  });
  const role = await db.role.create({
    data: {
      name: 'Worker-test-' + randomUUID(),
      permissions: { create: { permissionKey: permission.key } },
    },
  });
  userId = (
    await db.user.create({
      data: {
        name: 'Worker test',
        email: `worker-${randomUUID()}@test.invalid`,
        passwordHash: 'disabled-test-account',
        roles: { create: { roleId: role.id } },
      },
    })
  ).id;
  projectId = (
    await db.project.create({
      data: {
        code: 'JOB-' + randomUUID(),
        name: 'Background test project',
        access: { create: { userId } },
      },
    })
  ).id;
  worker = spawn(process.execPath, ['dist/src/jobs/worker.js'], {
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout?.on('data', (chunk: Buffer) => {
    workerLogs += chunk.toString();
  });
  worker.stderr?.on('data', (chunk: Buffer) => {
    workerLogs += chunk.toString();
  });
  await eventually(async () => workerLogs.includes('PMS worker ready'));
});
afterAll(async () => {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test worker did not stop')), 10000);
      worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.kill();
    });
  }
  await db.$disconnect();
  await redis.quit();
  storage.destroy();
});
it('dispatches the durable outbox through BullMQ and completes an actual export', async () => {
  const job = await transaction(async (tx) => {
    const job = await tx.backgroundJob.create({
      data: {
        projectId,
        createdBy: userId,
        kind: 'REPORT',
        payload: { report: { kind: 'inventory' }, format: 'xlsx' },
      },
    });
    await outbox(tx, 'export', { jobId: job.id });
    return job;
  });
  await eventually(async () => {
    const completed =
      (await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status === 'COMPLETED';
    const event = await db.outbox.findFirst({
      where: { payload: { path: ['jobId'], equals: job.id }, processedAt: { not: null } },
    });
    return completed && Boolean(event);
  });
  const completed = await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
  expect(completed.resultKey).toContain(job.id + '.xlsx');
  const event = await db.outbox.findFirstOrThrow({
    where: { payload: { path: ['jobId'], equals: job.id } },
  });
  expect(event.dispatchedAt).not.toBeNull();
  expect(event.processedAt).not.toBeNull();
});
it('delivers an in-app notification once and records the delivery attempt', async () => {
  const notification = await transaction(async (tx) => {
    const n = await tx.notification.create({
      data: { userId, title: 'Worker delivery', body: 'Safe test message', channel: 'IN_APP' },
    });
    await outbox(tx, 'notification', { notificationId: n.id });
    return n;
  });
  await eventually(
    async () =>
      (await db.notificationDelivery.count({
        where: { notificationId: notification.id, success: true },
      })) === 1,
  );
  await transaction((tx) => outbox(tx, 'notification', { notificationId: notification.id }));
  await eventually(
    async () =>
      (await db.outbox.count({
        where: {
          payload: { path: ['notificationId'], equals: notification.id },
          processedAt: null,
        },
      })) === 0,
  );
  expect(
    await db.notificationDelivery.count({
      where: { notificationId: notification.id, success: true },
    }),
  ).toBe(1);
});
