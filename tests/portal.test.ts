import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { ZodError } from 'zod';
import type { Prisma } from '@prisma/client';

vi.mock('../src/database/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/database/client.js')>();
  const { testDb } = await import('./embedded-postgres.js');
  return {
    ...original,
    db: testDb,
    transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      testDb.$transaction(work, { timeout: 20000 }),
  };
});
vi.mock('../src/integrations/redis.js', () => ({ throttle: vi.fn(async () => true) }));
vi.mock('../src/integrations/notifications.js', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../src/integrations/storage.js', () => ({
  signedDownload: vi.fn(async () => 'https://storage.example.invalid/signed'),
  putObject: vi.fn(async () => {}),
}));
import { embedded, testDb as db, closeEmbedded } from './embedded-postgres.js';
import { env } from '../src/config/env.js';
import { AppError } from '../src/common/errors.js';
import { endpoint } from '../src/common/http.js';
import { hash, decrypt } from '../src/common/security.js';
import { portalRoutes } from '../src/modules/portal/routes.js';
import { authRoutes } from '../src/modules/auth/routes.js';
import { passwordHash, login } from '../src/modules/auth/service.js';
import {
  inviteCustomer,
  acceptInvitation,
  revokeCustomer,
  deliverInvitation,
} from '../src/modules/portal/invitations.js';
import { sendEmail } from '../src/integrations/notifications.js';
import { putObject } from '../src/integrations/storage.js';

const app = express();
app.use(express.json(), cookieParser(), (_req, res, next) => {
  res.locals.requestId = randomUUID();
  next();
});
authRoutes(app);
portalRoutes(app);
endpoint(
  app,
  'get',
  '/staff-only',
  { permission: 'customers.read', summary: 'Test staff boundary' },
  async () => ({ secret: true }),
);
const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (!(error instanceof AppError) && !(error instanceof ZodError)) console.error(error);
  res
    .status(error instanceof AppError ? error.status : error instanceof ZodError ? 422 : 500)
    .json({ code: error.code, message: error.message });
};
app.use(errors);
const pass = 'Portal-Test-Password-123!';
let userA: string,
  staff: string,
  projectId: string,
  customerA: string,
  customerB: string,
  bookingA: string,
  bookingB: string,
  tokenA: string,
  tokenB: string,
  staffToken: string;
const get = (path: string, token = tokenA) =>
  request(app)
    .get('/api/v1' + path)
    .set('Authorization', 'Bearer ' + token);
const ctx = () => ({
  actor: {
    id: staff,
    sessionId: randomUUID(),
    accountType: 'STAFF' as const,
    permissions: new Set(['customers.portal.manage']),
  },
  projectId,
  requestId: randomUUID(),
});
async function customer(email: string, portalUserId?: string) {
  return db.customer.create({
    data: {
      name: email.split('@')[0]!,
      email,
      phone: '03001234567',
      projectId,
      reference: randomUUID(),
      identityEncrypted: 'encrypted-test',
      identityHash: randomUUID(),
      identityLast4: '1234',
      portalUserId,
    },
  });
}
async function pending(email: string) {
  const c = await customer(email);
  const token = 'invite-' + randomUUID() + randomUUID();
  const row = await db.customerInvitation.create({
    data: {
      customerId: c.id,
      email,
      hash: hash(token),
      expiresAt: new Date(Date.now() + 3600000),
      createdBy: staff,
    },
  });
  return { c, token, row };
}
beforeAll(async () => {
  for (const folder of (await readdir('prisma/migrations')).filter((f) => /^\d/.test(f)).sort())
    await embedded.exec(await readFile(`prisma/migrations/${folder}/migration.sql`, 'utf8'));
  env.SMTP_HOST = 'smtp.example.invalid';
  const password = await passwordHash(pass);
  const s = await db.user.create({
    data: { email: 'staff@example.invalid', name: 'Staff', passwordHash: password },
  });
  staff = s.id;
  const a = await db.user.create({
    data: {
      email: 'alice@example.invalid',
      name: 'Alice Customer',
      passwordHash: password,
      accountType: 'CUSTOMER',
    },
  });
  userA = a.id;
  const b = await db.user.create({
    data: {
      email: 'bob@example.invalid',
      name: 'Bob Customer',
      passwordHash: password,
      accountType: 'CUSTOMER',
    },
  });
  const project = await db.project.create({ data: { code: 'PORTAL-TEST', name: 'Test project' } });
  projectId = project.id;
  await db.userProjectAccess.create({ data: { userId: staff, projectId } });
  const role = await db.role.create({ data: { name: 'Portal test admin' } });
  for (const permissionKey of [
    'customers.portal.manage',
    'customers.read',
    'documents.manage',
    'customers.view_sensitive',
  ]) {
    await db.permission.upsert({
      where: { key: permissionKey },
      create: { key: permissionKey },
      update: {},
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionKey } });
  }
  await db.userRole.createMany({
    data: [
      { roleId: role.id, userId: staff },
      { roleId: role.id, userId: userA },
    ],
  });
  customerA = (await customer(a.email, a.id)).id;
  customerB = (await customer(b.email, b.id)).id;
  const plan = await db.paymentPlan.create({
    data: {
      projectId,
      name: 'Test plan',
      versions: { create: { version: 1, schedule: [], createdBy: staff } },
    },
    include: { versions: true },
  });
  for (const [index, customerId] of [customerA, customerB].entries()) {
    const unit = await db.unit.create({
      data: {
        projectId,
        number: 'U-' + index,
        type: 'RESIDENTIAL_PLOT',
        size: '100',
        measurementUnit: 'sq ft',
        price: '300.03',
        features: [],
      },
    });
    const reservation = await db.reservation.create({
      data: {
        reference: randomUUID(),
        unitId: unit.id,
        customerId,
        expiresAt: new Date(Date.now() + 3600000),
        createdBy: staff,
        status: 'CONVERTED',
      },
    });
    const booking = await db.booking.create({
      data: {
        reference: 'B-' + index,
        unitId: unit.id,
        customerId,
        reservationId: reservation.id,
        planVersionId: plan.versions[0]!.id,
        status: 'CONFIRMED',
        basePrice: '300.03',
        charges: '0',
        discount: '0',
        total: '300.03',
        downPayment: '100.01',
        createdBy: staff,
        owners: { create: { customerId, share: '100' } },
      },
    });
    if (index === 0) bookingA = booking.id;
    else bookingB = booking.id;
    await db.installment.createMany({
      data: [
        {
          bookingId: booking.id,
          sequence: 1,
          version: 1,
          label: 'First installment',
          dueDate: new Date('2026-01-01'),
          amount: '100.01',
        },
        {
          bookingId: booking.id,
          sequence: 2,
          version: 1,
          label: 'Second installment',
          dueDate: new Date('2026-02-01'),
          amount: '200.02',
        },
      ],
    });
  }
  const account = await db.account.create({
    data: { projectId, code: 'CASH', name: 'Cash', type: 'ASSET' },
  });
  const payment = await db.payment.create({
    data: {
      bookingId: bookingA,
      payerId: customerA,
      amount: '150.01',
      method: 'CASH',
      paidAt: new Date(),
      receivingAccountId: account.id,
      status: 'CLEARED',
      receivedBy: staff,
    },
  });
  const first = await db.installment.findFirstOrThrow({
    where: { bookingId: bookingA, sequence: 1 },
  });
  await db.paymentAllocation.create({
    data: { paymentId: payment.id, installmentId: first.id, amount: '100.01' },
  });
  await db.receipt.create({ data: { paymentId: payment.id, reference: 'RCPT-TEST' } });
  tokenA = (await login({ email: a.email, password: pass }, 'web', randomUUID())).accessToken;
  tokenB = (await login({ email: b.email, password: pass }, 'web', randomUUID())).accessToken;
  staffToken = (await login({ email: s.email, password: pass }, 'web', randomUUID())).accessToken;
}, 60000);
afterAll(async () => closeEmbedded());

describe('customer portal with real Prisma queries and embedded PostgreSQL', () => {
  it('keeps existing/default accounts as staff and strips accidental staff grants from customers', async () => {
    expect((await db.user.findUniqueOrThrow({ where: { id: staff } })).accountType).toBe('STAFF');
    const me = await get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.accountType).toBe('CUSTOMER');
    expect(me.body.data.permissions).toEqual([]);
    expect((await get('/staff-only')).status).toBe(403);
    expect((await get('/portal/bookings', staffToken)).status).toBe(403);
    expect((await request(app).get('/api/v1/portal/bookings')).status).toBe(401);
  });
  it('limits lists and guessed record IDs to the authenticated customer', async () => {
    const list = await get('/portal/bookings');
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((r: { id: string }) => r.id)).toEqual([bookingA]);
    expect((await get('/portal/bookings/' + bookingB)).status).toBe(404);
    expect((await get('/portal/installments?bookingId=' + bookingB)).body.data.items).toEqual([]);
    expect((await get('/portal/payments', tokenB)).body.data.items).toEqual([]);
    expect((await get('/portal/bookings?customerId=' + customerB)).status).toBe(422);
  });
  it('calculates exact balances and finds unpaid rows beyond fully paid installments', async () => {
    const response = await get('/portal/dashboard');
    expect(response.status).toBe(200);
    expect(response.body.data.accounts[0]).toMatchObject({
      bookings: 1,
      total: '300.03',
      paid: '150.01',
      outstanding: '200.02',
      advanceCredit: '50.00',
    });
    expect(response.body.data.upcoming).toHaveLength(1);
    expect(response.body.data.upcoming[0]).toMatchObject({
      bookingId: bookingA,
      label: 'Second installment',
      outstanding: '200.02',
    });
    expect(JSON.stringify(response.body)).not.toContain(bookingB);
  });
  it('allows a current joint owner and removes access when their ownership ends', async () => {
    const owner = await db.bookingOwner.create({
      data: { bookingId: bookingB, customerId: customerA, share: '25' },
    });
    expect((await get('/portal/bookings/' + bookingB)).status).toBe(200);
    const dashboard = await get('/portal/dashboard');
    expect(dashboard.body.data.accounts[0].bookings).toBe(2);
    await db.bookingOwner.update({ where: { id: owner.id }, data: { validTo: new Date() } });
    expect((await get('/portal/bookings/' + bookingB)).status).toBe(404);
    expect((await get('/portal/dashboard')).body.data.accounts[0].bookings).toBe(1);
  });
  it('scopes every workflow status to ownership and omits internal details', async () => {
    for (const bookingId of [bookingA, bookingB]) {
      const ndc = await db.ndc.create({
        data: {
          bookingId,
          reference: randomUUID(),
          requestedBy: staff,
          identityVerified: true,
          documentsVerified: true,
        },
      });
      await db.transfer.create({
        data: {
          bookingId,
          ndcId: ndc.id,
          buyerId: customerB,
          reference: randomUUID(),
          charges: '10.00',
          requestedBy: staff,
          paymentReference: 'INTERNAL-BANK-REFERENCE',
        },
      });
      const cancellation = await db.cancellation.create({
        data: {
          bookingId,
          deduction: '10.00',
          refundable: '90.00',
          reason: 'INTERNAL-CANCELLATION-NOTES',
          requestedBy: staff,
        },
      });
      await db.refund.create({
        data: {
          cancellationId: cancellation.id,
          amount: '90.00',
          requestedBy: staff,
          paymentReference: 'INTERNAL-BANK-REFERENCE',
        },
      });
      await db.possession.create({ data: { bookingId, requestedBy: staff } });
    }
    for (const kind of ['ndcs', 'transfers', 'refunds', 'possessions']) {
      const result = await get('/portal/requests?kind=' + kind);
      expect(result.status).toBe(200);
      expect(result.body.data.items).toHaveLength(1);
      expect(result.body.data.items[0].booking.id).toBe(bookingA);
      expect(JSON.stringify(result.body)).not.toMatch(
        /INTERNAL|buyerId|requestedBy|identityVerified/,
      );
      expect(
        (await get('/portal/requests?kind=' + kind + '&bookingId=' + bookingB)).body.data.items,
      ).toEqual([]);
    }
  });
  it('does not expose documents by default, or another customer’s explicitly linked document', async () => {
    const base = {
      projectId,
      bookingId: bookingA,
      name: 'Contract.pdf',
      mime: 'application/pdf',
      size: 42,
      sha256: 'test-hash',
      uploadedBy: staff,
    };
    const hidden = await db.document.create({ data: { ...base, key: 'hidden' } });
    const shared = await db.document.create({
      data: { ...base, key: 'shared', portalVisible: true },
    });
    const privateOther = await db.document.create({
      data: { ...base, key: 'other-customer', customerId: customerB, portalVisible: true },
    });
    const result = await get('/portal/documents');
    expect(result.body.data.items.map((r: { id: string }) => r.id)).toEqual([shared.id]);
    expect((await get('/portal/documents/' + hidden.id + '/download')).status).toBe(404);
    expect((await get('/portal/documents/' + privateOther.id + '/download')).status).toBe(404);
    expect((await get('/portal/documents/' + shared.id + '/download')).status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain('sha256');
    expect(JSON.stringify(result.body)).not.toContain('"key"');
    await db.document.update({ where: { id: shared.id }, data: { portalVisible: false } });
    expect((await get('/portal/documents/' + shared.id + '/download')).status).toBe(404);
  });
  it('produces a PDF statement only for an accessible booking', async () => {
    expect((await get('/portal/bookings/' + bookingB + '/statement/download')).status).toBe(404);
    const response = await get('/portal/bookings/' + bookingA + '/statement/download');
    expect(response.status).toBe(200);
    const bytes = vi.mocked(putObject).mock.calls.at(-1)![1];
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  });
  it('creates invitations without credentials or tokens in API responses and emails only valid invites', async () => {
    const c = await customer('new-customer@example.invalid');
    const result = await inviteCustomer(ctx(), c.id);
    expect(result.status).toBe('PENDING');
    expect(JSON.stringify(result)).not.toMatch(/token|password|hash/i);
    const event = await db.outbox.findFirstOrThrow({
      where: { kind: 'customer-invitation' },
      orderBy: { createdAt: 'desc' },
    });
    const payload = event.payload as { invitationId: string; encryptedToken: string };
    await deliverInvitation(payload.invitationId, payload.encryptedToken, event.id);
    expect(sendEmail).toHaveBeenCalledWith(
      c.email,
      expect.any(String),
      expect.stringContaining('/portal/activate#token='),
      event.id,
    );
    const token = decrypt(payload.encryptedToken);
    await acceptInvitation(token, pass);
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: c.id }, include: { portalUser: true } }))
        .portalUser?.accountType,
    ).toBe('CUSTOMER');
    await expect(acceptInvitation(token, pass)).rejects.toMatchObject({
      code: 'INVITATION_INVALID',
    });
  });
  it('rejects expired invitations, revoked invitations, changed emails, and staff email collisions', async () => {
    for (const kind of ['expired', 'revoked', 'changed']) {
      const { c, row, token } = await pending(kind + '@example.invalid');
      if (kind === 'expired')
        await db.customerInvitation.update({
          where: { id: row.id },
          data: { expiresAt: new Date(0) },
        });
      if (kind === 'revoked')
        await db.customerInvitation.update({
          where: { id: row.id },
          data: { revokedAt: new Date() },
        });
      if (kind === 'changed')
        await db.customer.update({
          where: { id: c.id },
          data: { email: 'changed-to@example.invalid' },
        });
      await expect(acceptInvitation(token, pass)).rejects.toMatchObject({
        code: 'INVITATION_INVALID',
      });
    }
    const { token } = await pending('staff@example.invalid');
    await expect(acceptInvitation(token, pass)).rejects.toMatchObject({
      code: 'EXISTING_CUSTOMER_PASSWORD_REQUIRED',
    });
  });
  it('requires the existing customer password to link another profile and never resets that password', async () => {
    const { c, token } = await pending('alice@example.invalid');
    const before = (await db.user.findUniqueOrThrow({ where: { id: userA } })).passwordHash;
    await expect(acceptInvitation(token, 'Wrong-Existing-Password-123')).rejects.toMatchObject({
      code: 'EXISTING_CUSTOMER_PASSWORD_REQUIRED',
    });
    await acceptInvitation(token, pass);
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).portalUserId).toBe(userA);
    expect((await db.user.findUniqueOrThrow({ where: { id: userA } })).passwordHash).toBe(before);
  });
  it('blocks customer invitations, document sharing, and notification tampering', async () => {
    expect(
      (
        await request(app)
          .post(`/api/v1/projects/${projectId}/customers/${customerB}/portal/invite`)
          .set('Authorization', 'Bearer ' + tokenA)
          .send({})
      ).status,
    ).toBe(403);
    const notice = await db.notification.create({
      data: { customerId: customerB, title: 'Private', body: 'Other customer', channel: 'IN_APP' },
    });
    expect(
      (
        await request(app)
          .post('/api/v1/portal/notifications/' + notice.id + '/read')
          .set('Authorization', 'Bearer ' + tokenA)
          .send({})
      ).status,
    ).toBe(404);
    expect((await get('/portal/notifications')).body.data.items).toEqual([]);
  });
  it('removes former-owner access after transfer while granting it to the new owner', async () => {
    await db.bookingOwner.updateMany({
      where: { bookingId: bookingA },
      data: { validTo: new Date() },
    });
    await db.booking.update({ where: { id: bookingA }, data: { customerId: customerB } });
    await db.bookingOwner.create({
      data: { bookingId: bookingA, customerId: customerB, share: '100' },
    });
    expect((await get('/portal/bookings/' + bookingA)).status).toBe(404);
    expect((await get('/portal/bookings/' + bookingA, tokenB)).status).toBe(200);
    expect((await get('/portal/payments', tokenB)).body.data.items).toEqual([]);
  });
  it('revokes linked access and active sessions without deleting business records', async () => {
    await revokeCustomer(ctx(), customerB);
    expect((await get('/portal/bookings', tokenB)).status).toBe(401);
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: customerB } })).portalUserId,
    ).toBeNull();
    expect(await db.booking.count({ where: { id: bookingB } })).toBe(1);
  });
});
