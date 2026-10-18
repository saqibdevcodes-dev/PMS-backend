import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn(async (_message: unknown) => ({})) }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock('../src/database/client.js', async (original) => ({
  ...(await original<typeof import('../src/database/client.js')>()),
  db: (await import('./embedded-postgres.js')).testDb,
  transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    (await import('./embedded-postgres.js')).testDb.$transaction(work, { timeout: 20000 }),
}));
vi.mock('../src/integrations/redis.js', () => ({ throttle: vi.fn(async () => true) }));
import { embedded, testDb as db, closeEmbedded } from './embedded-postgres.js';
import { transaction } from '../src/database/client.js';
import { emailUser, welcomeUser, customerUpdate } from '../src/common/notifications.js';
import {
  login,
  refresh,
  passwordHash,
  changePassword,
  resetPassword,
} from '../src/modules/auth/service.js';
import { deliverNotification } from '../src/integrations/notifications.js';

import { businessEvent } from '../src/jobs/events.js';
import { hash } from '../src/common/security.js';

const pass = 'Email-Test-Password-123!';
let staffId: string,
  customerId: string,
  approverId: string,
  secondApproverId: string,
  projectId: string;
const context = (id = staffId, grants: string[] = []) => ({
  actor: {
    id,
    sessionId: randomUUID(),
    accountType: 'STAFF' as const,
    permissions: new Set(grants),
  },
  projectId,
  requestId: randomUUID(),
});
const notices = (userId: string, title: string) =>
  db.notification.findMany({ where: { userId, title, channel: 'EMAIL' } });

beforeAll(async () => {
  for (const folder of (await readdir('prisma/migrations')).filter((f) => /^\d/.test(f)).sort())
    await embedded.exec(await readFile(`prisma/migrations/${folder}/migration.sql`, 'utf8'));
  const password = await passwordHash(pass);
  staffId = (
    await db.user.create({
      data: {
        name: '<script>alert(1)</script>',
        email: 'staff@test.invalid',
        passwordHash: password,
      },
    })
  ).id;
  customerId = (
    await db.user.create({
      data: {
        name: 'Customer',
        email: 'customer@test.invalid',
        passwordHash: password,
        accountType: 'CUSTOMER',
      },
    })
  ).id;
  projectId = (
    await db.project.create({
      data: { code: 'EMAIL', name: 'Email project', access: { create: { userId: staffId } } },
    })
  ).id;
  for (const key of ['discounts.approve', 'bookings.approve'])
    await db.permission.create({ data: { key } });
  const role = await db.role.create({
    data: {
      name: 'Email approver',
      permissions: {
        create: [{ permissionKey: 'discounts.approve' }, { permissionKey: 'bookings.approve' }],
      },
    },
  });
  const createApprover = async (
    email: string,
    project: boolean,
    active = true,
    accountType: 'STAFF' | 'CUSTOMER' = 'STAFF',
  ) =>
    (
      await db.user.create({
        data: {
          name: email,
          email,
          passwordHash: password,
          active,
          accountType,
          roles: { create: { roleId: role.id } },
          ...(project ? { projects: { create: { projectId } } } : {}),
        },
      })
    ).id;
  approverId = await createApprover('approver@test.invalid', true);
  secondApproverId = await createApprover('second@test.invalid', true);
  await createApprover('outside@test.invalid', false);
  await createApprover('disabled@test.invalid', true, false);
  await createApprover('portal@test.invalid', true, true, 'CUSTOMER');
}, 60000);
afterAll(closeEmbedded);
beforeEach(() => sendMail.mockReset().mockResolvedValue({}));

it('queues separate staff and customer welcomes with the correct sign-in links and no passwords', async () => {
  await transaction(async (tx) => {
    await welcomeUser(tx, staffId);
    await welcomeUser(tx, customerId);
  });
  const staff = (await notices(staffId, 'Welcome to Etihad Real Estate'))[0]!;
  const customer = (await notices(customerId, 'Welcome to Etihad Real Estate'))[0]!;
  expect(staff.body).toContain('http://localhost:3000/login');
  expect(customer.body).toContain('http://localhost:3000/portal/login');
  for (const n of [staff, customer]) {
    expect(n.body).not.toContain(pass);
    expect(
      await db.outbox.count({
        where: { kind: 'notification', payload: { path: ['notificationId'], equals: n.id } },
      }),
    ).toBe(1);
  }
  expect(sendMail).not.toHaveBeenCalled();
});

it('emails every successful staff/customer web/native login, but not refreshes or failed attempts', async () => {
  for (const [userId, email] of [
    [staffId, 'staff@test.invalid'],
    [customerId, 'customer@test.invalid'],
  ]) {
    const before = (await notices(userId!, 'New sign-in to your account')).length;
    for (const platform of ['web', 'android']) {
      const session = await login({ email: email!, password: pass }, platform, randomUUID(), {
        ip: '192.0.2.10',
        userAgent: 'Test browser',
      });
      await refresh(session.refreshToken, platform !== 'web');
      expect(JSON.stringify(await notices(userId!, 'New sign-in to your account'))).not.toContain(
        session.accessToken,
      );
    }
    await expect(
      login({ email: email!, password: 'wrong' }, 'web', randomUUID()),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const messages = await notices(userId!, 'New sign-in to your account');
    expect(messages).toHaveLength(before + 2);
    expect(messages.at(-1)!.body).toContain('192.0.2.10');
    expect(messages.at(-1)!.body).toContain('Test browser');
    expect(JSON.stringify(messages)).not.toContain(pass);
  }
  expect(sendMail).not.toHaveBeenCalled();
});

it('rolls back queued email when the triggering transaction fails', async () => {
  const title = 'Rolled back event';
  await expect(
    transaction(async (tx) => {
      await emailUser(tx, staffId, title, 'This must never be sent.');
      throw new Error('Business change rejected');
    }),
  ).rejects.toThrow('Business change rejected');
  expect(await db.notification.count({ where: { title } })).toBe(0);
});

it('respects customer update consent, including withdrawal before delivery', async () => {
  const customer = await db.customer.create({
    data: {
      projectId,
      portalUserId: customerId,
      reference: 'CONSENT',
      name: 'Customer',
      email: 'customer@test.invalid',
      phone: '03001234567',
      identityEncrypted: 'test',
      identityHash: 'consent-test',
      identityLast4: '1234',
    },
  });
  await transaction((tx) => customerUpdate(tx, customer.id, 'Optional property update'));
  const welcome = await db.notification.create({
    data: {
      customerId: customer.id,
      recipient: customer.email,
      channel: 'EMAIL',
      title: 'Welcome to Etihad Real Estate',
      body: 'Your customer profile has been registered.',
    },
  });
  await deliverNotification(welcome.id, true);
  expect(sendMail).toHaveBeenCalledOnce();
  sendMail.mockClear();
  expect(
    await db.notification.count({
      where: { customerId: customer.id, channel: 'EMAIL', title: 'Optional property update' },
    }),
  ).toBe(0);
  await db.customer.update({ where: { id: customer.id }, data: { communicationConsent: true } });
  await transaction((tx) => customerUpdate(tx, customer.id, 'Optional property update'));
  const email = await db.notification.findFirstOrThrow({
    where: { customerId: customer.id, channel: 'EMAIL', title: 'Optional property update' },
  });
  await db.customer.update({ where: { id: customer.id }, data: { communicationConsent: false } });
  await deliverNotification(email.id);
  expect(sendMail).not.toHaveBeenCalled();
  expect(
    await db.notificationDelivery.findFirst({
      where: { notificationId: email.id, success: false },
    }),
  ).not.toBeNull();
  // Account security emails still reach the same user regardless of optional update consent.
  const security = await transaction((tx) =>
    emailUser(tx, customerId, 'Account security', 'Security confirmation.'),
  );
  await deliverNotification(security.id);
  expect(sendMail).toHaveBeenCalledOnce();
});

it('records SMTP failure, supports retry, escapes HTML and skips an already delivered email', async () => {
  const n = await transaction((tx) => emailUser(tx, staffId, 'Security update', 'A safe update.'));
  sendMail.mockRejectedValueOnce(new Error('SMTP temporarily unavailable'));
  await expect(deliverNotification(n.id)).rejects.toThrow('SMTP temporarily unavailable');
  expect(
    await db.notificationDelivery.count({ where: { notificationId: n.id, success: false } }),
  ).toBe(1);
  await deliverNotification(n.id);
  await deliverNotification(n.id);
  expect(sendMail).toHaveBeenCalledTimes(2);
  const message = sendMail.mock.calls.at(-1)![0] as { html: string; text: string; to: string };
  expect(message.to).toBe('staff@test.invalid');
  expect(message.html).toContain('&lt;script&gt;');
  expect(message.html).not.toContain('<script>');
  expect(message.text).toContain('A safe update.');
  expect(
    await db.notificationDelivery.count({ where: { notificationId: n.id, success: true } }),
  ).toBe(1);
});

it('creates project update emails once for active project staff only', async () => {
  const payload = { projectId, kind: 'Project record updated', entityId: randomUUID() };
  const event = await db.outbox.create({ data: { kind: 'business-event', payload } });
  await businessEvent(event);
  await businessEvent(event);
  const emails = await db.notification.findMany({
    where: { channel: 'EMAIL', title: payload.kind },
  });
  expect(new Set(emails.map((n) => n.userId))).toEqual(
    new Set([staffId, approverId, secondApproverId]),
  );
  expect(emails).toHaveLength(3);
});

it('sends password-change confirmations for changes and resets without including credentials', async () => {
  const next = 'Updated-Email-Password-456!';
  await changePassword(context(customerId), pass, next);
  const token = 'r'.repeat(64);
  await db.passwordReset.create({
    data: { userId: customerId, hash: hash(token), expiresAt: new Date(Date.now() + 60000) },
  });
  await resetPassword(token, pass);
  const messages = await notices(customerId, 'Your password has changed');
  expect(messages).toHaveLength(2);
  expect(JSON.stringify(messages)).not.toContain(next);
  expect(JSON.stringify(messages)).not.toContain(token);
});
