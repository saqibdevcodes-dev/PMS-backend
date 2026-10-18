import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import argon2 from 'argon2';

vi.mock('../src/database/client.js', async (original) => ({
  ...(await original<typeof import('../src/database/client.js')>()),
  db: (await import('./embedded-postgres.js')).testDb,
  transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    (await import('./embedded-postgres.js')).testDb.$transaction(work, { timeout: 20000 }),
}));
vi.mock('../src/modules/auth/service.js', async (original) => ({
  ...(await original<typeof import('../src/modules/auth/service.js')>()),
  authenticate: async (token: string) => {
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first.');
    return {
      id: token === 'other' ? otherId : staffId,
      sessionId: randomUUID(),
      accountType: token === 'customer' ? 'CUSTOMER' : 'STAFF',
      permissions: new Set(
        token === 'viewer'
          ? ['inventory.read']
          : token === 'creator'
            ? ['customers.create', 'customers.update', 'customers.read']
            : token === 'booker'
              ? ['inventory.read', 'reservations.create', 'bookings.create']
              : permissions,
      ),
    };
  },
}));
vi.mock('../src/integrations/storage.js', () => ({
  putObject: vi.fn(async () => {}),
  signedDownload: vi.fn(async () => 'https://storage.example.invalid/temporary'),
}));
vi.mock('../src/integrations/redis.js', () => ({ throttle: vi.fn(async () => true) }));
import { embedded, testDb as db, closeEmbedded } from './embedded-postgres.js';
import { AppError } from '../src/common/errors.js';
import { permissions } from '../src/common/permissions.js';
import { imageRoutes } from '../src/modules/images/routes.js';
import { foundationRoutes } from '../src/modules/foundation/routes.js';
import { crmRoutes } from '../src/modules/crm/routes.js';
import { documentRoutes } from '../src/modules/documents/routes.js';
import { decimal, sum } from '../src/common/money.js';
import { createPayment } from '../src/modules/sales/service.js';
import { salesRoutes } from '../src/modules/sales/routes.js';
import { signedDownload, putObject } from '../src/integrations/storage.js';
import { login } from '../src/modules/auth/service.js';
import { workflowRoutes } from '../src/modules/workflows/routes.js';
import { transferChecks, possessionChecks, handoverReceipt } from './ownership-fixtures.js';
import { decrypt } from '../src/common/security.js';
import { resendCredentials, deliverCredentials } from '../src/modules/portal/credentials.js';
vi.mock('../src/integrations/notifications.js', () => ({ sendEmail: vi.fn(async () => {}) }));
import { sendEmail } from '../src/integrations/notifications.js';
const nationalId = () => '35202' + String(randomInt(10000000, 99999999));

const app = express();
app.use(express.json(), (_req, res, next) => {
  res.locals.requestId = randomUUID();
  next();
});
imageRoutes(app);
foundationRoutes(app);
crmRoutes(app);
documentRoutes(app);
salesRoutes(app);
workflowRoutes(app);
const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  res
    .status(
      error instanceof AppError
        ? error.status
        : error instanceof ZodError || error.name === 'MulterError'
          ? 422
          : 500,
    )
    .json({ code: error.code, message: error.message, details: error.issues });
};
app.use(errors);
let staffId: string,
  otherId: string,
  projectId: string,
  otherProject: string,
  bookingId: string,
  accountId: string;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=',
  'base64',
);
const post = (path: string, token = 'staff') =>
  request(app)
    .post('/api/v1' + path)
    .set('Authorization', 'Bearer ' + token);
const get = (path: string, token = 'staff') =>
  request(app)
    .get('/api/v1' + path)
    .set('Authorization', 'Bearer ' + token);
async function upload(purpose: string, project?: string) {
  let req = post('/images').field('purpose', purpose);
  if (project) req = req.field('projectId', project);
  const res = await req.attach('file', png, 'photo.png');
  expect(res.status, res.text).toBe(201);
  return res.body.data.id as string;
}
const context = () => ({
  actor: {
    id: staffId,
    sessionId: randomUUID(),
    accountType: 'STAFF' as const,
    permissions: new Set(permissions),
  },
  projectId,
  requestId: randomUUID(),
});
beforeAll(async () => {
  for (const folder of (await readdir('prisma/migrations')).filter((f) => /^\d/.test(f)).sort())
    await embedded.exec(await readFile(`prisma/migrations/${folder}/migration.sql`, 'utf8'));
  staffId = (
    await db.user.create({
      data: {
        name: 'Image admin',
        email: 'image-admin@example.invalid',
        passwordHash: 'test-only',
      },
    })
  ).id;
  otherId = (
    await db.user.create({
      data: {
        name: 'Other admin',
        email: 'other-admin@example.invalid',
        passwordHash: 'test-only',
      },
    })
  ).id;
  projectId = (await db.project.create({ data: { code: 'IMAGES', name: 'Image project' } })).id;
  otherProject = (await db.project.create({ data: { code: 'OTHER', name: 'Other project' } })).id;
  await db.userProjectAccess.create({ data: { userId: staffId, projectId } });
  accountId = (
    await db.account.create({ data: { projectId, code: 'BANK', name: 'Bank', type: 'ASSET' } })
  ).id;
  const customer = await db.customer.create({
    data: {
      projectId,
      name: 'Buyer',
      phone: '03001234567',
      reference: 'C-1',
      identityEncrypted: 'test',
      identityHash: 'test',
      identityLast4: '1234',
    },
  });
  const unit = await db.unit.create({
    data: {
      projectId,
      number: 'U-1',
      type: 'APARTMENT',
      size: '100',
      measurementUnit: 'sq ft',
      price: '1000',
      features: [],
    },
  });
  const reservation = await db.reservation.create({
    data: {
      reference: 'R-1',
      unitId: unit.id,
      customerId: customer.id,
      createdBy: staffId,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const plan = await db.paymentPlan.create({
    data: {
      projectId,
      name: 'Plan',
      versions: { create: { version: 1, schedule: [], createdBy: staffId } },
    },
    include: { versions: true },
  });
  bookingId = (
    await db.booking.create({
      data: {
        reference: 'B-1',
        unitId: unit.id,
        customerId: customer.id,
        reservationId: reservation.id,
        planVersionId: plan.versions[0]!.id,
        status: 'CONFIRMED',
        basePrice: '1000',
        charges: '0',
        discount: '0',
        total: '1000',
        downPayment: '200',
        createdBy: staffId,
      },
    })
  ).id;
}, 60000);
afterAll(closeEmbedded);

describe('installment collection and committed inventory', () => {
  async function collectionFixture() {
    const project = await post('/projects').send({
      name: 'Collection ' + randomUUID().slice(0, 8),
      location: 'Karachi',
    });
    expect(project.status, project.text).toBe(201);
    const pid = project.body.data.id as string;
    await db.userProjectAccess.create({ data: { userId: otherId, projectId: pid } });
    const buyer = await db.customer.create({
      data: {
        projectId: pid,
        reference: randomUUID(),
        name: 'Collection buyer',
        phone: '03001234567',
        identityEncrypted: 'test',
        identityHash: randomUUID(),
        identityLast4: '0001',
      },
    });
    const unit = await db.unit.create({
      data: {
        projectId: pid,
        number: 'C-01',
        type: 'APARTMENT',
        size: '100',
        measurementUnit: 'sq ft',
        price: '1000',
        status: 'SOLD',
      },
    });
    const booking = await db.booking.create({
      data: {
        reference: randomUUID(),
        unitId: unit.id,
        customerId: buyer.id,
        basePrice: '1000',
        charges: '0',
        discount: '0',
        total: '1000',
        downPayment: '200',
        createdBy: staffId,
        paymentType: 'INSTALLMENTS',
        status: 'CONFIRMED',
        owners: { create: { customerId: buyer.id, share: '100' } },
      },
    });
    const first = await db.installment.create({
      data: {
        bookingId: booking.id,
        sequence: 0,
        version: 1,
        label: 'Down payment',
        dueDate: new Date('2026-01-01'),
        amount: '200',
      },
    });
    const second = await db.installment.create({
      data: {
        bookingId: booking.id,
        sequence: 1,
        version: 1,
        label: 'First installment',
        dueDate: new Date('2026-02-01'),
        amount: '800',
      },
    });
    const base = '/projects/' + pid;
    const input = { expectedAmount: '200', method: 'CASH', paidAt: new Date().toISOString() };
    const collect = (id: string, body = input, key = randomUUID(), token = 'staff') =>
      post(base + '/installments/' + id + '/payment', token)
        .set('Idempotency-Key', key)
        .send(body);
    return { pid, base, booking, unit, first, second, input, collect };
  }
  it('atomically approves cash once, enforces the next installment and rejects stale amounts', async () => {
    const f = await collectionFixture();
    expect((await f.collect(f.first.id, f.input, randomUUID(), 'booker')).status).toBe(403);
    expect((await f.collect(f.second.id, { ...f.input, expectedAmount: '800' })).body.code).toBe(
      'INSTALLMENT_NOT_NEXT',
    );
    expect((await f.collect(f.first.id, { ...f.input, expectedAmount: '201' })).body.code).toBe(
      'INSTALLMENT_AMOUNT_CHANGED',
    );
    const key = randomUUID();
    const result = await f.collect(f.first.id, f.input, key);
    expect(result.status, result.text).toBe(200);
    expect(result.body.data.status).toBe('CLEARED');
    expect(result.body.data.receipt.reference).toBeTruthy();
    expect((await f.collect(f.first.id, f.input, key)).body.data.id).toBe(result.body.data.id);
    expect(await db.payment.count({ where: { bookingId: f.booking.id } })).toBe(1);
    expect(await db.receipt.count({ where: { paymentId: result.body.data.id } })).toBe(1);
    expect((await f.collect(f.first.id)).body.code).toBe('INSTALLMENT_NOT_NEXT');
    const listing = await get(f.base + '/bookings');
    expect(listing.body.data.items).toContainEqual(
      expect.objectContaining({
        id: f.booking.id,
        paid: '200.00',
        outstanding: '800.00',
        pendingPayments: 0,
        customer: expect.objectContaining({ name: 'Collection buyer' }),
        unit: expect.objectContaining({ size: '100' }),
      }),
    );
    const edited = await request(app)
      .patch('/api/v1' + f.base + '/units/' + f.unit.id)
      .set('Authorization', 'Bearer staff')
      .send({ phase: 'Changed' });
    expect(edited.body.code).toBe('UNIT_COMMITTED');
    expect(
      (await post(f.base + '/units/' + f.unit.id + '/price').send({ price: '1500', charges: '0' }))
        .status,
    ).not.toBe(200);
    expect((await db.unit.findUniqueOrThrow({ where: { id: f.unit.id } })).price.toString()).toBe(
      '1000',
    );
  });
  it('requires cheque numbers, prevents duplicate pending collections and requires an independent verifier', async () => {
    const f = await collectionFixture();
    expect((await f.collect(f.first.id, { ...f.input, method: 'CHEQUE' })).body.code).toBe(
      'PAYMENT_REFERENCE_REQUIRED',
    );
    const body = { ...f.input, method: 'CHEQUE', transactionReference: 'CH-1001' };
    const result = await f.collect(f.first.id, body);
    expect(result.status, result.text).toBe(200);
    expect(result.body.data.status).toBe('PENDING');
    expect((await f.collect(f.first.id, body)).body.code).toBe('PAYMENT_PENDING');
    const verify = (token: string) =>
      post(f.base + '/payments/' + result.body.data.id + '/verify', token)
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'CLEARED', reason: 'Funds received in bank' });
    expect((await verify('staff')).body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
    const approved = await verify('other');
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.data.status).toBe('CLEARED');
  });
  it('requires bank proof, transaction ID and receiving account in the same project', async () => {
    const f = await collectionFixture();
    const account = await db.account.findFirstOrThrow({
      where: { projectId: f.pid, type: 'ASSET' },
    });
    const body = { ...f.input, method: 'BANK_TRANSFER', transactionReference: 'TX-1' };
    expect((await f.collect(f.first.id, body)).body.code).toBe('BANK_ACCOUNT_REQUIRED');
    expect(
      (await f.collect(f.first.id, { ...body, receivingAccountId: account.id } as typeof body)).body
        .code,
    ).toBe('PAYMENT_PROOF_REQUIRED');
    const proofImageId = await upload('PAYMENT', f.pid);
    const result = await f.collect(f.first.id, {
      ...body,
      proofImageId,
      receivingAccountId: account.id,
    } as typeof body);
    expect(result.status, result.text).toBe(200);
    expect(result.body.data.status).toBe('PENDING');
    expect(await db.receipt.count({ where: { paymentId: result.body.data.id } })).toBe(0);
  });
});

describe('authority-aware transfer and possession', () => {
  const root = () => `/projects/${projectId}`;
  const patchChecks = (kind: string, id: string, verification: unknown) =>
    request(app)
      .patch('/api/v1' + root() + `/${kind}/${id}/verification`)
      .set('Authorization', 'Bearer staff')
      .send({ verification });
  async function fixture(paid = true) {
    const customer = await db.customer.findFirstOrThrow({ where: { projectId } });
    const buyer = await db.customer.create({
      data: {
        projectId,
        reference: randomUUID(),
        name: 'New owner',
        phone: '03001234567',
        identityEncrypted: 'test',
        identityHash: randomUUID(),
        identityLast4: '5678',
      },
    });
    const unit = await db.unit.create({
      data: {
        projectId,
        number: randomUUID(),
        type: 'APARTMENT',
        size: '100',
        measurementUnit: 'sq ft',
        price: '1000',
        status: 'SOLD',
      },
    });
    const booking = await db.booking.create({
      data: {
        reference: randomUUID(),
        unitId: unit.id,
        customerId: customer.id,
        basePrice: '1000',
        charges: '0',
        discount: '0',
        total: '1000',
        downPayment: '0',
        createdBy: staffId,
        paymentType: 'FULL_PAYMENT',
        status: 'CONFIRMED',
        owners: { create: { customerId: customer.id, share: '100' } },
      },
    });
    const installment = await db.installment.create({
      data: {
        bookingId: booking.id,
        sequence: 1,
        version: 1,
        label: 'Full price',
        dueDate: new Date('2026-01-01'),
        amount: '1000',
      },
    });
    if (paid)
      await db.payment.create({
        data: {
          bookingId: booking.id,
          payerId: customer.id,
          amount: '1000',
          method: 'CASH',
          paidAt: new Date(),
          receivedBy: staffId,
          receivingAccountId: accountId,
          status: 'CLEARED',
          allocations: { create: { installmentId: installment.id, amount: '1000' } },
        },
      });
    return { customer, buyer, unit, booking };
  }
  it('transfers without a separate NDC, retains previous owners and rejects duplicate completion', async () => {
    const f = await fixture();
    const response = await post(root() + '/transfers').send({
      bookingId: f.booking.id,
      buyerId: f.buyer.id,
      charges: '0',
      verification: transferChecks,
    });
    expect(response.status, response.text).toBe(200);
    const transfer = response.body.data.transfer;
    expect(transfer.ndcId).toBeNull();
    expect(transfer.verification).toMatchObject({
      ...transferChecks,
      verifiedBy: staffId,
      checkedOwnerIds: [f.customer.id],
    });
    const complete = await post(root() + `/transfers/${transfer.id}/complete`).send({});
    expect(complete.status, complete.text).toBe(200);
    const owners = await db.bookingOwner.findMany({ where: { bookingId: f.booking.id } });
    expect(owners).toHaveLength(2);
    expect(owners.find((o) => o.customerId === f.customer.id)?.validTo).not.toBeNull();
    expect(owners.find((o) => o.customerId === f.buyer.id)?.validTo).toBeNull();
    expect((await post(root() + `/transfers/${transfer.id}/complete`).send({})).status).toBe(409);
    expect((await patchChecks('transfers', transfer.id, transferChecks)).status).toBe(409);
    expect((await get(`/projects/${otherProject}/transfers/${transfer.id}`)).status).toBe(404);
  });
  it('requires checked documents and clearance evidence and blocks outstanding dues', async () => {
    const f = await fixture(false);
    const body = { bookingId: f.booking.id, buyerId: f.buyer.id, charges: '0' };
    for (const verification of [
      undefined,
      { ...transferChecks, identityVerified: false },
      { ...transferChecks, clearanceReason: '' },
      { ...transferChecks, clearanceStatus: 'VERIFIED' },
      {
        ...transferChecks,
        clearanceStatus: 'VERIFIED',
        clearanceReference: 'NDC-10',
        clearanceValidUntil: '2020-01-01',
      },
    ]) {
      expect((await post(root() + '/transfers').send({ ...body, verification })).status).toBe(422);
    }
    const unpaid = await post(root() + '/transfers').send({
      ...body,
      verification: transferChecks,
    });
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.code).toBe('OUTSTANDING_DUES');
    expect(
      (
        await post(root() + '/possessions').send({
          bookingId: f.booking.id,
          verification: possessionChecks,
        })
      ).body.code,
    ).toBe('OUTSTANDING_DUES');
  });
  it('rechecks clearance expiry, allows a recorded review and preserves transfer fee checks', async () => {
    const f = await fixture();
    const response = await post(root() + '/transfers').send({
      bookingId: f.booking.id,
      buyerId: f.buyer.id,
      charges: '50',
      verification: {
        ...transferChecks,
        clearanceStatus: 'VERIFIED',
        clearanceReference: 'NDC-100',
        clearanceValidUntil: '2099-01-01',
      },
    });
    expect(response.status, response.text).toBe(200);
    const transfer = response.body.data.transfer;
    expect((await post(root() + `/transfers/${transfer.id}/complete`).send({})).body.code).toBe(
      'TRANSFER_FEE_REQUIRED',
    );
    expect(
      (
        await post(root() + `/transfers/${transfer.id}/verify-fee`).send({
          accountId,
          paymentReference: 'BANK-100',
        })
      ).status,
    ).toBe(403);
    // Simulate the passage of time after fee settlement without touching a live ledger.
    await db.transfer.update({
      where: { id: transfer.id },
      data: {
        paidAt: new Date(),
        verification: { ...transfer.verification, clearanceValidUntil: '2020-01-01' },
      },
    });
    expect((await post(root() + `/transfers/${transfer.id}/complete`).send({})).body.code).toBe(
      'VERIFICATION_REQUIRED',
    );
    const reviewed = await patchChecks('transfers', transfer.id, transferChecks);
    expect(reviewed.status, reviewed.text).toBe(200);
    expect(
      await db.auditLog.count({
        where: { entityId: transfer.id, action: 'transfers.documents_reviewed' },
      }),
    ).toBe(1);
    expect(
      (await get(root() + `/transfers/${transfer.id}`)).body.data.verification.clearanceReason,
    ).toBe(transferChecks.clearanceReason);
    expect((await post(root() + `/transfers/${transfer.id}/complete`).send({})).status).toBe(200);
  });
  it('requires inspection, resolved snags and a signed receipt before handover', async () => {
    const f = await fixture();
    const response = await post(root() + '/possessions').send({
      bookingId: f.booking.id,
      verification: possessionChecks,
    });
    expect(response.status, response.text).toBe(200);
    const possession = response.body.data.possession;
    const path = root() + `/possessions/${possession.id}`;
    expect((await post(path + '/handover').send(handoverReceipt)).body.code).toBe(
      'INSPECTION_REQUIRED',
    );
    const inspected = await post(path + '/inspection').send({
      notes: 'Site inspected',
      snags: ['Repair entrance'],
    });
    expect(inspected.status, inspected.text).toBe(200);
    expect((await post(path + '/handover').send(handoverReceipt)).body.code).toBe(
      'UNRESOLVED_SNAGS',
    );
    await post(root() + `/snags/${inspected.body.data.snags[0].id}/resolve`).send({});
    expect((await post(path + '/handover').send({})).status).toBe(422);
    const complete = await post(path + '/handover').send(handoverReceipt);
    expect(complete.status, complete.text).toBe(200);
    expect(complete.body.data).toMatchObject({ ...handoverReceipt, status: 'COMPLETED' });
    expect((await db.unit.findUniqueOrThrow({ where: { id: f.unit.id } })).status).toBe(
      'POSSESSED',
    );
    expect((await post(path + '/handover').send(handoverReceipt)).status).toBe(409);
  });
  it('blocks handover when ownership changed and supports reviewing old requests', async () => {
    const f = await fixture();
    const legacy = await db.possession.create({
      data: { bookingId: f.booking.id, requestedBy: staffId, inspectionAt: new Date() },
    });
    const path = root() + `/possessions/${legacy.id}/handover`;
    expect((await post(path).send(handoverReceipt)).body.code).toBe('VERIFICATION_REQUIRED');
    expect((await patchChecks('possessions', legacy.id, possessionChecks)).status).toBe(200);
    await db.bookingOwner.updateMany({
      where: { bookingId: f.booking.id, validTo: null },
      data: { validTo: new Date() },
    });
    await db.bookingOwner.create({
      data: { bookingId: f.booking.id, customerId: f.buyer.id, share: '100' },
    });
    expect((await post(path).send(handoverReceipt)).body.code).toBe('OWNERS_CHANGED');
    expect((await db.unit.findUniqueOrThrow({ where: { id: f.unit.id } })).status).toBe('SOLD');
    expect((await patchChecks('possessions', legacy.id, possessionChecks)).status).toBe(200);
    expect((await post(path).send(handoverReceipt)).status).toBe(200);
  });
});

describe('customer and property portfolios', () => {
  it('groups the complete directory using cleared payments, current owners and active bookings', async () => {
    const project = await db.project.create({ data: { code: 'PORTFOLIO', name: 'Portfolio' } });
    await db.userProjectAccess.create({ data: { userId: staffId, projectId: project.id } });
    const customers = await Promise.all(
      ['Installment', 'Paid', 'Unassigned', 'Draft', 'Full unpaid', 'Former owner'].map((name) =>
        db.customer.create({
          data: {
            projectId: project.id,
            name,
            phone: '03001234567',
            reference: randomUUID(),
            identityHash: randomUUID(),
            identityEncrypted: 'secret',
            identityLast4: '1234',
          },
        }),
      ),
    );
    async function booking(
      index: number,
      paymentType: string,
      status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED' = 'CONFIRMED',
    ) {
      const unit = await db.unit.create({
        data: {
          projectId: project.id,
          number: randomUUID(),
          type: 'APARTMENT',
          size: '100',
          measurementUnit: 'sq ft',
          price: '1000',
        },
      });
      return db.booking.create({
        data: {
          reference: randomUUID(),
          unitId: unit.id,
          customerId: customers[index]!.id,
          basePrice: '1000',
          charges: '0',
          discount: '0',
          total: '1000',
          downPayment: '0',
          createdBy: staffId,
          paymentType,
          status,
          owners: { create: { customerId: customers[index]!.id, share: '100' } },
        },
      });
    }
    const installment = await booking(0, 'INSTALLMENTS');
    const paid = await booking(1, 'FULL_PAYMENT');
    await booking(2, 'INSTALLMENTS', 'CANCELLED');
    await booking(3, 'INSTALLMENTS', 'DRAFT');
    const full = await booking(4, 'FULL_PAYMENT');
    const transfer = await booking(5, 'INSTALLMENTS');
    await db.bookingOwner.updateMany({
      where: { bookingId: transfer.id },
      data: { validTo: new Date() },
    });
    await db.bookingOwner.create({
      data: { bookingId: transfer.id, customerId: customers[0]!.id, share: '100' },
    });
    const paymentData = {
      amount: '1000',
      method: 'CASH' as const,
      paidAt: new Date(),
      receivedBy: staffId,
      receivingAccountId: (
        await db.account.create({
          data: { projectId: project.id, code: 'CASH', name: 'Cash', type: 'ASSET' },
        })
      ).id,
    };
    await db.payment.create({
      data: { ...paymentData, bookingId: paid.id, payerId: customers[1]!.id, status: 'CLEARED' },
    });
    await db.payment.create({
      data: { ...paymentData, bookingId: full.id, payerId: customers[4]!.id, status: 'PENDING' },
    });
    const base = `/projects/${project.id}`;
    const result = await get(base + '/customers?limit=1');
    expect(result.status, result.text).toBe(200);
    expect(result.body.data.groups).toEqual({
      ALL: 6,
      INSTALLMENTS: 1,
      FULLY_PAID: 1,
      UNASSIGNED: 2,
      PENDING: 2,
    });
    expect(result.body.data.pagination.total).toBe(6);
    expect(result.body.data.items).toHaveLength(1);
    const filtered = await get(base + '/customers?group=INSTALLMENTS');
    expect(filtered.body.data.pagination.total).toBe(1);
    expect(filtered.body.data.items[0]).toMatchObject({
      id: customers[0]!.id,
      paymentStatus: 'INSTALLMENTS',
    });
    expect(filtered.body.data.items[0].bookings).toHaveLength(2);
    expect(filtered.body.data.items[0].identityEncrypted).toBeUndefined();
    expect(
      (await get(base + '/customers?search=Former&group=UNASSIGNED')).body.data.groups.ALL,
    ).toBe(1);
    const unit = await get(base + '/units/' + transfer.unitId);
    expect(unit.body.data.bookings[0].customers).toEqual([
      { id: customers[0]!.id, name: 'Installment' },
    ]);
    expect(unit.body.data.bookings[0].status).toBe('CONFIRMED');
    expect(
      (await get(base + '/units/' + transfer.unitId, 'viewer')).body.data.bookings,
    ).toBeUndefined();
    expect((await get(base + '/customers?group=INSTALLMENTS', 'creator')).status).toBe(403);
    expect((await get(base + '/customers', 'creator')).body.data.groups).toBeUndefined();
    expect((await get(base + '/customers', 'other')).status).toBe(404);
    expect((await get(`/projects/${otherProject}/units/${transfer.unitId}`)).status).toBe(404);
    await db.payment.create({
      data: {
        ...paymentData,
        bookingId: installment.id,
        payerId: customers[0]!.id,
        status: 'CLEARED',
      },
    });
    expect((await get(base + '/customers/' + customers[0]!.id)).body.data.paymentStatus).toBe(
      'INSTALLMENTS',
    );
    const final = await db.payment.create({
      data: {
        ...paymentData,
        bookingId: transfer.id,
        payerId: customers[0]!.id,
        status: 'CLEARED',
      },
    });
    expect((await get(base + '/customers/' + customers[0]!.id)).body.data.paymentStatus).toBe(
      'FULLY_PAID',
    );
    expect((await get(base + '/customers?group=FULLY_PAID')).body.data.pagination.total).toBe(2);
    await db.payment.update({ where: { id: final.id }, data: { status: 'REVERSED' } });
    expect((await get(base + '/customers?group=INSTALLMENTS')).body.data.pagination.total).toBe(1);
  });
});

describe('private record images and guided form contracts', () => {
  it('creates and directly confirms a booking without a hold, rejects duplicates, and keeps permissions', async () => {
    const unit = await post(`/projects/${projectId}/units`).send({
      number: 'HOLD-EDIT',
      type: 'RESIDENTIAL_PLOT',
      size: '5',
      measurementUnit: 'marla',
      price: '1000',
    });
    const customer = await db.customer.create({
      data: {
        projectId,
        name: 'Booking customer',
        phone: '03001234567',
        reference: randomUUID(),
        identityHash: randomUUID(),
        identityEncrypted: 'test',
        identityLast4: '1234',
      },
    });
    const input = {
      unitId: unit.body.data.id,
      customerId: customer.id,
      paymentType: 'FULL_PAYMENT',
      confirm: true,
    };
    expect((await post(`/projects/${projectId}/bookings`, 'booker').send(input)).status).toBe(403);
    const created = await post(`/projects/${projectId}/bookings`).send(input);
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.booking).toMatchObject({
      status: 'CONFIRMED',
      reservationId: null,
      planVersionId: null,
      downPayment: '0',
      paymentType: 'FULL_PAYMENT',
    });
    expect(await db.approval.count({ where: { entityId: created.body.data.booking.id } })).toBe(0);
    expect((await db.unit.findUniqueOrThrow({ where: { id: input.unitId } })).status).toBe('SOLD');
    expect((await post(`/projects/${projectId}/bookings`).send(input)).status).toBe(409);
    expect(
      (
        await post(`/projects/${projectId}/reservations`).send({
          unitId: input.unitId,
          customerId: customer.id,
        })
      ).status,
    ).toBe(404);
  });
  it('requires authentication, staff access, purpose permission and project membership', async () => {
    expect(
      (await request(app).post('/api/v1/images').attach('file', png, 'photo.png')).status,
    ).toBe(401);
    for (const token of ['customer', 'viewer'])
      expect(
        (
          await post('/images', token)
            .field('purpose', 'UNIT')
            .field('projectId', projectId)
            .attach('file', png, 'photo.png')
        ).status,
      ).toBe(403);
    expect(
      (await post('/images').field('purpose', 'UNIT').attach('file', png, 'photo.png')).status,
    ).toBe(422);
    expect(
      (
        await post('/images')
          .field('purpose', 'UNIT')
          .field('projectId', otherProject)
          .attach('file', png, 'photo.png')
      ).status,
    ).toBe(404);
  });
  it('rejects spoofed and oversized images before storage', async () => {
    vi.mocked(putObject).mockClear();
    expect(
      (
        await post('/images')
          .field('purpose', 'PROJECT')
          .attach('file', Buffer.from('not an image'), 'photo.png')
      ).status,
    ).toBe(422);
    expect(
      (await post('/images').field('purpose', 'PROJECT').attach('file', png, 'photo.jpg')).status,
    ).toBe(422);
    expect(
      (
        await post('/images')
          .field('purpose', 'PROJECT')
          .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'large.png')
      ).status,
    ).toBe(422);
    expect(putObject).not.toHaveBeenCalled();
  });
  it('stores project photos and limits signed previews to project members', async () => {
    const photoId = await upload('PROJECT');
    const created = await post('/projects').send({
      name: 'New photographed project',
      location: 'Karachi',
      photoId,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.photoId).toBe(photoId);
    const preview = await get('/images/' + photoId);
    expect(preview.status).toBe(200);
    expect(preview.body.data.expiresIn).toBe(120);
    expect((await get('/images/' + photoId, 'other')).status).toBe(404);
    expect((await get('/images/' + photoId, 'customer')).status).toBe(404);
    const cleared = await request(app)
      .patch('/api/v1/projects/' + created.body.data.id)
      .set('Authorization', 'Bearer staff')
      .send({ photoId: null });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.data.photoId).toBeNull();
  });
  it('persists Other property details and feature images, and rejects unrelated images', async () => {
    const photoId = await upload('UNIT', projectId),
      featureId = await upload('FEATURE', projectId);
    const body = {
      number: 'OTHER-1',
      type: 'OTHER',
      typeDetails: 'Warehouse',
      size: '1200',
      measurementUnit: 'sq ft',
      price: '10000',
      photoId,
      features: ['Loading bay'],
      featureImages: [{ feature: 'Loading bay', imageId: featureId }],
    };
    const created = await post(`/projects/${projectId}/units`).send(body);
    expect(created.status, created.text).toBe(201);
    expect(created.body.data).toMatchObject({
      typeDetails: 'Warehouse',
      photoId,
      featureImages: body.featureImages,
    });
    expect(
      (
        await post(`/projects/${projectId}/units`).send({
          ...body,
          number: 'OTHER-2',
          typeDetails: undefined,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(`/projects/${projectId}/units`).send({
          ...body,
          number: 'OTHER-3',
          measurementUnit: 'free text',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(`/projects/${projectId}/units`).send({
          ...body,
          number: 'OTHER-4',
          features: [],
        })
      ).body.code,
    ).toBe('FEATURE_IMAGE_MISMATCH');
    const foreign = await db.imageAsset.create({
      data: {
        projectId: otherProject,
        purpose: 'UNIT',
        uploadedBy: staffId,
        name: 'other.png',
        key: randomUUID(),
        mime: 'image/png',
        size: 1,
      },
    });
    expect(
      (
        await post(`/projects/${projectId}/units`).send({
          ...body,
          number: 'OTHER-5',
          photoId: foreign.id,
        })
      ).body.code,
    ).toBe('IMAGE_SCOPE_MISMATCH');
    expect((await get('/images/' + photoId, 'other')).status).toBe(404);
  });
  it('saves five project photos, allows members to retain them, and supports replacing, reordering and clearing', async () => {
    const photoIds = [];
    for (let i = 0; i < 5; i++) photoIds.push(await upload('PROJECT'));
    const created = await post('/projects').send({
      name: 'Gallery project',
      location: 'Lahore',
      currency: 'AED',
      photoIds,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.data).toMatchObject({ photoIds, photoId: photoIds[0] });
    const galleryProject = created.body.data.id;
    const patch = (body: object, token = 'staff') =>
      request(app)
        .patch('/api/v1/projects/' + galleryProject)
        .set('Authorization', 'Bearer ' + token)
        .send(body);
    expect((await get('/images/' + photoIds[4], 'other')).status).toBe(404);
    expect((await patch({ photoIds }, 'other')).status).toBe(404);
    await db.userProjectAccess.create({ data: { userId: otherId, projectId: galleryProject } });
    expect((await get('/images/' + photoIds[4], 'other')).status).toBe(200);
    expect((await patch({ photoIds }, 'other')).status).toBe(200);
    expect((await patch({ name: 'Renamed gallery' })).body.data).toMatchObject({
      photoIds,
      currency: 'AED',
    });
    const replacement = await upload('PROJECT');
    expect((await patch({ photoIds: [...photoIds, replacement] })).status).toBe(422);
    expect((await patch({ photoIds: [photoIds[0], photoIds[0]] })).body.code).toBe(
      'INVALID_GALLERY',
    );
    expect((await patch({ photoIds, photoId: photoIds[1] })).body.code).toBe('INVALID_GALLERY');
    // An older client can replace just the cover without losing the other four photos.
    const legacy = await patch({ photoId: replacement });
    expect(legacy.body.data.photoIds).toEqual([replacement, ...photoIds.slice(1)]);
    const next = [photoIds[4], replacement, ...photoIds.slice(1, 4)];
    const reordered = await patch({ photoIds: next });
    expect(reordered.body.data).toMatchObject({ photoIds: next, photoId: next[0] });
    const cleared = await patch({ photoIds: [] });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.data).toMatchObject({ photoIds: [], photoId: null });
    expect((await get('/images/' + photoIds[4], 'other')).status).toBe(404);
    const otherUpload = await db.imageAsset.create({
      data: {
        purpose: 'PROJECT',
        uploadedBy: otherId,
        key: randomUUID(),
        name: 'private.png',
        mime: 'image/png',
        size: 1,
      },
    });
    expect((await patch({ photoIds: [otherUpload.id] })).body.code).toBe('IMAGE_SCOPE_MISMATCH');
  });
  it('edits property galleries within project scope without allowing price or status changes', async () => {
    const photoIds = [];
    for (let i = 0; i < 5; i++) photoIds.push(await upload('UNIT', projectId));
    const featureImages = [{ feature: 'Balcony', imageId: await upload('FEATURE', projectId) }];
    const created = await post(`/projects/${projectId}/units`).send({
      number: 'GALLERY-1',
      type: 'APARTMENT',
      size: '100',
      measurementUnit: 'sq ft',
      price: '1000',
      photoIds,
      features: ['Balcony'],
      featureImages,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.data).toMatchObject({ photoIds, photoId: photoIds[0] });
    const path = `/projects/${projectId}/units/${created.body.data.id}`;
    const patch = (body: object, token = 'staff', url = path) =>
      request(app)
        .patch('/api/v1' + url)
        .set('Authorization', 'Bearer ' + token)
        .send(body);
    expect((await patch({ photoIds }, 'viewer')).status).toBe(403);
    expect((await patch({ photoIds }, 'other')).status).toBe(404);
    expect(
      (
        await patch(
          { photoIds },
          'staff',
          `/projects/${otherProject}/units/${created.body.data.id}`,
        )
      ).status,
    ).toBe(404);
    for (const body of [
      { price: '1' },
      { charges: '1' },
      { status: 'SOLD' },
      { photoIds: [...photoIds, photoIds[0]] },
    ])
      expect((await patch(body)).status).toBe(422);
    expect((await patch({ number: 'GALLERY-UPDATED' })).body.data).toMatchObject({
      photoIds,
      features: ['Balcony'],
      featureImages,
    });
    expect((await patch({ photoIds: [photoIds[0], photoIds[0]] })).body.code).toBe(
      'INVALID_GALLERY',
    );
    const wrongPurpose = await upload('FEATURE', projectId);
    expect((await patch({ photoIds: [wrongPurpose] })).body.code).toBe('IMAGE_SCOPE_MISMATCH');
    const foreign = await db.imageAsset.create({
      data: {
        projectId: otherProject,
        purpose: 'UNIT',
        uploadedBy: staffId,
        key: randomUUID(),
        name: 'foreign.png',
        mime: 'image/png',
        size: 1,
      },
    });
    expect((await patch({ photoIds: [foreign.id] })).body.code).toBe('IMAGE_SCOPE_MISMATCH');
    expect((await patch({ photoIds: [randomUUID()] })).status).toBe(404);
    const replacement = await upload('UNIT', projectId);
    const next = [replacement, ...photoIds.slice(1)];
    const updated = await patch({ photoIds: next });
    expect(updated.status, updated.text).toBe(200);
    expect((await get(path)).body.data).toMatchObject({
      photoIds: next,
      photoId: replacement,
      price: '1000',
    });
    expect((await patch({ photoIds: [] })).body.data).toMatchObject({
      photoIds: [],
      photoId: null,
    });
    const saved = await db.unit.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(saved.price.toString()).toBe('1000');
    expect(saved.status).toBe('AVAILABLE');
    expect(
      await db.auditLog.count({ where: { entityId: saved.id, action: 'inventory.updated' } }),
    ).toBeGreaterThan(0);
  });
  it('retires dealer endpoints and validates employee photo purpose', async () => {
    const dealer = { name: 'Dealer', phone: '03001234567', commissionPercent: '2' };
    expect((await post(`/projects/${projectId}/dealers`).send(dealer)).status).toBe(404);
    const photoId = await upload('CUSTOMER', projectId);
    expect((await post(`/projects/${projectId}/dealers`).send({ ...dealer, photoId })).status).toBe(
      404,
    );
    const staff = {
      name: 'New staff',
      email: 'new-photo@example.invalid',
      password: 'Strong-Test-Password-123',
      roleIds: [],
      projectIds: [projectId],
    };
    expect((await post('/users').send(staff)).status).toBe(422);
    expect((await post('/users').send({ ...staff, photoId })).body.code).toBe(
      'IMAGE_SCOPE_MISMATCH',
    );
    const staffPhoto = await upload('USER');
    expect((await post('/users').send({ ...staff, photoId: staffPhoto })).status).toBe(201);
    const createdUser = await db.user.findUniqueOrThrow({ where: { email: staff.email } });
    expect(
      await db.notification.count({
        where: { userId: createdUser.id, channel: 'EMAIL', title: 'Welcome to Etihad Real Estate' },
      }),
    ).toBe(1);
    expect(createdUser.photoId).toBe(staffPhoto);
  });
  it('saves customer photos, returns previews and supports replacing and removing them', async () => {
    const photoId = await upload('CUSTOMER', projectId);
    const path = `/projects/${projectId}/customers`;
    const body = {
      name: 'Photographed customer',
      phone: '03001234567',
      identity: nationalId(),
      email: 'photo-customer@example.invalid',
      photoId,
    };
    const created = await post(path, 'creator').send(body);
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.photoId).toBe(photoId);
    const customerPath = path + '/' + created.body.data.id;
    expect((await get(customerPath)).body.data.photoId).toBe(photoId);
    expect((await get(path)).body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.data.id, photoId })]),
    );
    expect((await get('/images/' + photoId, 'creator')).status).toBe(200);
    expect((await get('/images/' + photoId, 'other')).status).toBe(404);
    expect((await get('/images/' + photoId, 'viewer')).status).toBe(403);
    expect((await get('/images/' + photoId, 'customer')).status).toBe(404);
    const replacement = await upload('CUSTOMER', projectId);
    for (const nextPhoto of [replacement, null]) {
      const updated = await request(app)
        .patch('/api/v1' + customerPath)
        .set('Authorization', 'Bearer creator')
        .send({ photoId: nextPhoto });
      expect(updated.status, updated.text).toBe(200);
      expect(updated.body.data.photoId).toBe(nextPhoto);
    }
    const saved = await db.customer.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(saved.portalUserId).not.toBeNull();
  });
  it('rejects customer photos with the wrong purpose or project on creation and editing', async () => {
    const path = `/projects/${projectId}/customers`;
    const body = {
      name: 'Photo scope customer',
      phone: '03001234567',
      identity: nationalId(),
      email: 'photo-scope@example.invalid',
    };
    const created = await post(path).send(body);
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.photoId).toBeNull();
    const wrongPurpose = await upload('UNIT', projectId);
    const foreign = await db.imageAsset.create({
      data: {
        projectId: otherProject,
        purpose: 'CUSTOMER',
        uploadedBy: staffId,
        name: 'other-customer.png',
        key: randomUUID(),
        mime: 'image/png',
        size: 1,
      },
    });
    for (const photoId of [wrongPurpose, foreign.id]) {
      expect((await post(path).send({ ...body, identity: nationalId(), photoId })).body.code).toBe(
        'IMAGE_SCOPE_MISMATCH',
      );
      expect(
        (
          await request(app)
            .patch('/api/v1' + path + '/' + created.body.data.id)
            .set('Authorization', 'Bearer staff')
            .send({ photoId })
        ).body.code,
      ).toBe('IMAGE_SCOPE_MISMATCH');
    }
    expect(
      (await post('/images').field('purpose', 'CUSTOMER').attach('file', png, 'photo.png')).status,
    ).toBe(422);
    expect(
      (
        await post('/images')
          .field('purpose', 'CUSTOMER')
          .field('projectId', otherProject)
          .attach('file', png, 'photo.png')
      ).status,
    ).toBe(404);
  });
  it('creates a usable customer-only portal account with a hashed password and no exposed credentials', async () => {
    const email = 'new-portal@example.invalid';
    const created = await post(`/projects/${projectId}/customers`).send({
      name: 'New portal customer',
      phone: '03001234567',
      identity: nationalId(),
      email: email.toUpperCase(),
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.email).toBe(email);
    expect(created.text).not.toMatch(/password|hash|portalUserId|accessToken|refreshToken/);
    const customer = await db.customer.findUniqueOrThrow({ where: { id: created.body.data.id } });
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(customer.portalUserId).toBe(user.id);
    expect(user.accountType).toBe('CUSTOMER');
    const event = await db.outbox.findFirstOrThrow({
      where: {
        kind: 'customer-credentials',
        payload: { path: ['customerId'], equals: customer.id },
      },
    });
    const payload = event.payload as { encryptedPassword: string; issuedAt: string };
    const pass = decrypt(payload.encryptedPassword);
    expect(pass.length).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(event)).not.toContain(pass);
    vi.mocked(sendEmail).mockClear();
    await deliverCredentials(customer.id, payload.encryptedPassword, payload.issuedAt, event.id);
    expect(sendEmail).toHaveBeenCalledWith(
      email,
      expect.any(String),
      expect.stringContaining(pass),
      event.id,
    );
    expect(user.passwordHash).not.toBe(pass);
    expect(await argon2.verify(user.passwordHash, pass)).toBe(true);
    expect(await db.userRole.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.userProjectAccess.count({ where: { userId: user.id } })).toBe(0);
    const signedIn = await login({ email, password: pass }, 'web', randomUUID());
    expect((await db.session.findUniqueOrThrow({ where: { id: signedIn.sessionId } })).userId).toBe(
      user.id,
    );
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).firstLoginAt,
    ).not.toBeNull();
    await expect(resendCredentials(context(), customer.id)).rejects.toMatchObject({
      code: 'CREDENTIALS_ALREADY_USED',
    });
    vi.mocked(sendEmail).mockClear();
    await deliverCredentials(customer.id, payload.encryptedPassword, payload.issuedAt, event.id);
    expect(sendEmail).not.toHaveBeenCalled();
    const audit = await db.auditLog.findMany({ where: { entityId: customer.id } });
    expect(audit.map((entry) => entry.action)).toContain('customer.portal_account_created');
    expect(JSON.stringify(audit)).not.toMatch(/Customer-Password-123|passwordHash|argon2/);
  });
  it('retires lead endpoints and still emails recovery assignments', async () => {
    const path = `/projects/${projectId}`;
    expect((await post(path + '/leads').send({ name: 'Legacy lead' })).status).toBe(404);
    const recovery = await post(path + '/recovery-cases').send({ bookingId, assignedTo: staffId });
    expect(recovery.status, recovery.text).toBe(200);
    expect(
      await db.notification.count({
        where: { userId: staffId, title: 'New recovery case assigned to you', channel: 'EMAIL' },
      }),
    ).toBe(1);
  });
  it('requires email and valid CNIC, generates credentials for customer creators, and rejects admin-entered passwords', async () => {
    const path = `/projects/${projectId}/customers`;
    const body = { name: 'Portal validation', phone: '03001234567', identity: nationalId() };
    const password = 'Customer-Password-123';
    expect((await post(path).send({ ...body, password })).status).toBe(422);
    expect(
      (await post(path).send({ ...body, email: 'weak@example.invalid', password: 'weak' })).status,
    ).toBe(422);
    for (const identity of ['123', '35202-123456-1', '35202123456789', 'ABCD123456789'])
      expect(
        (await post(path).send({ ...body, identity, email: 'invalid-cnic@example.invalid' }))
          .status,
      ).toBe(422);
    expect(
      (await post(path, 'viewer').send({ ...body, email: 'forbidden@example.invalid' })).status,
    ).toBe(403);
    const customer = await post(path, 'creator').send({
      ...body,
      email: 'generated@example.invalid',
    });
    expect(customer.status, customer.text).toBe(201);
    expect(
      (
        await request(app)
          .patch('/api/v1' + path + '/' + customer.body.data.id)
          .set('Authorization', 'Bearer staff')
          .send({ password })
      ).status,
    ).toBe(422);
  });
  it('queues encrypted credentials without marketing consent and resends only before first login', async () => {
    const email = 'profile-welcome@example.invalid';
    const response = await post(`/projects/${projectId}/customers`).send({
      name: 'New customer profile',
      phone: '03001234567',
      identity: '35202-1234567-1',
      email,
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.data.communicationConsent).toBe(false);
    const customerId = response.body.data.id as string;
    const original = await db.outbox.findFirstOrThrow({
      where: {
        kind: 'customer-credentials',
        payload: { path: ['customerId'], equals: customerId },
      },
    });
    const payload = original.payload as { encryptedPassword: string; issuedAt: string };
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await expect(resendCredentials(context(), customerId)).rejects.toMatchObject({
      code: 'CREDENTIALS_THROTTLED',
    });
    await db.user.update({
      where: { id: user.id },
      data: { credentialsIssuedAt: new Date(Date.now() - 61000) },
    });
    expect(await resendCredentials(context(), customerId)).toEqual({ queued: true, email });
    const refreshed = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await argon2.verify(refreshed.passwordHash, decrypt(payload.encryptedPassword))).toBe(
      false,
    );
    vi.mocked(sendEmail).mockClear();
    await deliverCredentials(customerId, payload.encryptedPassword, payload.issuedAt, original.id);
    expect(sendEmail).not.toHaveBeenCalled();
    const replacement = await db.outbox.findFirstOrThrow({
      where: {
        kind: 'customer-credentials',
        id: { not: original.id },
        payload: { path: ['customerId'], equals: customerId },
      },
    });
    const next = replacement.payload as { encryptedPassword: string; issuedAt: string };
    expect(await argon2.verify(refreshed.passwordHash, decrypt(next.encryptedPassword))).toBe(true);
    await deliverCredentials(customerId, next.encryptedPassword, next.issuedAt, replacement.id);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await expect(
      resendCredentials({ ...context(), projectId: otherProject }, customerId),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('emails account status, access and administrator session changes to the affected user', async () => {
    const user = await db.user.create({
      data: { name: 'Managed staff', email: 'managed@example.invalid', passwordHash: 'test-only' },
    });
    const patch = (active: boolean) =>
      request(app)
        .patch('/api/v1/users/' + user.id)
        .set('Authorization', 'Bearer staff')
        .send({ active });
    expect((await patch(false)).status).toBe(200);
    expect((await patch(false)).status).toBe(200);
    expect((await patch(true)).status).toBe(200);
    expect(
      (await post('/users/' + user.id + '/access').send({ roleIds: [], projectIds: [projectId] }))
        .status,
    ).toBe(200);
    expect((await post('/users/' + user.id + '/revoke-sessions').send({})).status).toBe(200);
    const notifications = await db.notification.findMany({
      where: { userId: user.id, channel: 'EMAIL' },
    });
    expect(notifications.map((n) => n.title).sort()).toEqual(
      [
        'Your account has been disabled',
        'Your account has been enabled',
        'Your account access has changed',
        'Your sessions have been signed out',
      ].sort(),
    );
  });
  it('never overwrites or links existing accounts, and rolls back portal creation if the customer fails', async () => {
    const path = `/projects/${projectId}/customers`;
    const body = {
      name: 'Existing account',
      phone: '03001234567',
      identity: nationalId(),
      email: 'created-collision@example.invalid',
    };
    const customerAccount = await db.user.create({
      data: {
        name: 'Existing portal customer',
        email: 'existing-portal@example.invalid',
        accountType: 'CUSTOMER',
        passwordHash: 'unchanged-customer-password',
      },
    });
    const staffAccount = await db.user.findUniqueOrThrow({ where: { id: staffId } });
    const disabledAccount = await db.user.create({
      data: {
        name: 'Disabled customer',
        email: 'disabled-portal@example.invalid',
        accountType: 'CUSTOMER',
        passwordHash: 'unchanged',
        active: false,
      },
    });
    for (const account of [customerAccount, staffAccount, disabledAccount]) {
      const attempted = await post(path).send({
        ...body,
        identity: nationalId(),
        email: account.email,
      });
      expect(attempted.status, attempted.text).toBe(409);
      expect(attempted.body.code).toBe('EMAIL_UNAVAILABLE');
      expect((await db.user.findUniqueOrThrow({ where: { id: account.id } })).passwordHash).toBe(
        account.passwordHash,
      );
    }
    expect(await db.customer.count({ where: { name: body.name } })).toBe(0);
    await post(path).send(body).expect(201);
    const email = 'rolled-back-portal@example.invalid';
    const rejected = await post(path).send({ ...body, email });
    expect(rejected.status).not.toBe(201);
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });
  it('requires proof for electronic payments, a cheque number and details for Other, preserving retries', async () => {
    const body = {
      bookingId,
      amount: '25.00',
      paidAt: new Date(Date.now() - 1000).toISOString(),
      receivingAccountId: accountId,
    };
    for (const method of ['BANK_TRANSFER', 'PAY_ORDER', 'OTHER'])
      await expect(
        createPayment(context(), { ...body, method }, randomUUID()),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROOF_REQUIRED' });
    await expect(
      createPayment(context(), { ...body, method: 'CHEQUE' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'PAYMENT_REFERENCE_REQUIRED' });
    expect(
      await createPayment(
        context(),
        { ...body, method: 'CHEQUE', transactionReference: 'CH-123' },
        randomUUID(),
      ),
    ).toMatchObject({ status: 'PENDING', proofImageId: null });
    const proofImageId = await upload('PAYMENT', projectId);
    await expect(
      createPayment(context(), { ...body, method: 'OTHER', proofImageId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_DETAILS_REQUIRED' });
    const wrong = await upload('UNIT', projectId);
    await expect(
      createPayment(
        context(),
        { ...body, method: 'BANK_TRANSFER', transactionReference: 'TX-123', proofImageId: wrong },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_SCOPE_MISMATCH' });
    const key = randomUUID(),
      input = { ...body, method: 'OTHER', methodDetails: 'Mobile wallet', proofImageId };
    const payment = await createPayment(context(), input, key);
    expect(payment).toMatchObject({ proofImageId, methodDetails: 'Mobile wallet' });
    expect((await createPayment(context(), input, key)).id).toBe(payment.id);
    expect(await createPayment(context(), { ...body, method: 'CASH' }, randomUUID())).toMatchObject(
      { proofImageId: null },
    );
  });
  it('requires a safe display name and preserves it in private downloads', async () => {
    const path = `/projects/${projectId}/documents`;
    expect((await post(path).attach('file', png, 'original.png')).status).toBe(422);
    expect(
      (await post(path).field('name', '../bad').attach('file', png, 'original.png')).status,
    ).toBe(422);
    const res = await post(path)
      .field('name', 'Booking agreement A-104')
      .attach('file', png, 'original.png');
    expect(res.status, res.text).toBe(201);
    expect(res.body.data.name).toBe('Booking agreement A-104.png');
    await get(path + '/' + res.body.data.id + '/download').expect(200);
    expect(signedDownload).toHaveBeenLastCalledWith(
      expect.any(String),
      'Booking agreement A-104.png',
    );
  });
});

describe('simplified project and payment workflows', () => {
  it('generates unique readable codes, persists amenities, and keeps minimum payments in settings', async () => {
    const featureImage = await upload('PROJECT');
    const body = {
      name: 'Same project name',
      location: 'Lahore',
      description: 'Garden community',
      features: ['Security', 'Water'],
      featureImages: [{ feature: 'Security', imageId: featureImage }],
    };
    const first = await post('/projects').send(body),
      second = await post('/projects').send(body);
    expect(first.status, first.text).toBe(201);
    expect(second.status, second.text).toBe(201);
    expect(first.body.data.code).toMatch(/^PRJ-\d{8}$/);
    expect(first.body.data.code).not.toBe(second.body.data.code);
    const pid = first.body.data.id;
    const patch = (path: string, body: object) =>
      request(app)
        .patch('/api/v1/projects/' + pid + path)
        .set('Authorization', 'Bearer staff')
        .send(body);
    expect((await patch('', { downPaymentPercent: '40' })).status).toBe(422);
    expect(
      (await patch('/settings', { downPaymentPercent: '40', ndcValidityDays: 30 })).status,
    ).toBe(200);
    expect((await patch('', { description: 'Changed description' })).body.data).toMatchObject({
      features: body.features,
      featureImages: body.featureImages,
      downPaymentPercent: '40',
      location: 'Lahore',
    });
    expect((await get('/projects/' + pid)).body.data).toMatchObject({
      location: 'Lahore',
      description: 'Changed description',
      features: body.features,
    });
    await db.userProjectAccess.create({ data: { userId: otherId, projectId: pid } });
    expect((await get('/images/' + featureImage, 'other')).status).toBe(200);
  });
  it('keeps customers out of employee results and blocks assigning staff roles to a customer account', async () => {
    const customer = await db.user.create({
      data: {
        name: 'Portal account',
        email: 'separate@example.invalid',
        passwordHash: 'test',
        accountType: 'CUSTOMER',
      },
    });
    const result = await get('/users');
    expect(result.status).toBe(200);
    expect(result.body.data.items.some((u: { id: string }) => u.id === staffId)).toBe(true);
    expect(result.body.data.items.some((u: { id: string }) => u.id === customer.id)).toBe(false);
    expect(
      (
        await post('/users/' + customer.id + '/access').send({
          roleIds: [],
          projectIds: [projectId],
        })
      ).status,
    ).toBe(404);
    expect((await post('/users/' + customer.id + '/revoke-sessions').send({})).status).toBe(404);
  });
  it('reconciles installment rounding, minimum down payment, cleared receipts, revisions and reversals without approval records', async () => {
    const p = await post('/projects').send({ name: 'Payment test', location: 'Karachi' });
    expect(p.status, p.text).toBe(201);
    const pid = p.body.data.id,
      base = '/projects/' + pid;
    await db.userProjectAccess.create({ data: { userId: otherId, projectId: pid } });
    const c = await post(base + '/customers').send({
      name: 'Installment buyer',
      phone: '03001234567',
      identity: nationalId(),
      email: 'installment-buyer@example.invalid',
    });
    const u = await post(base + '/units').send({
      number: 'I-01',
      type: 'APARTMENT',
      size: '100',
      measurementUnit: 'sq ft',
      price: '1000',
    });
    const body = {
      customerId: c.body.data.id,
      unitId: u.body.data.id,
      paymentType: 'INSTALLMENTS',
      downPayment: '200',
      installmentCount: 3,
      intervalMonths: 1,
      firstInstallmentDate: '2090-01-31',
      confirm: true,
    };
    expect(
      (await post(base + '/bookings').send({ ...body, downPayment: '199.99' })).body.code,
    ).toBe('INVALID_DOWN_PAYMENT');
    expect((await post(base + '/bookings').send({ ...body, discount: '1001' })).body.code).toBe(
      'INVALID_DISCOUNT',
    );
    const booking = await post(base + '/bookings').send(body);
    expect(booking.status, booking.text).toBe(201);
    const bid = booking.body.data.booking.id;
    const rows = await db.installment.findMany({
      where: { bookingId: bid },
      orderBy: { sequence: 'asc' },
    });
    expect(rows.map((r) => r.amount.toFixed(2))).toEqual(['200.00', '266.66', '266.66', '266.68']);
    expect(rows[2]!.dueDate.toISOString().slice(0, 10)).toBe('2090-02-28');
    expect(sum(rows.map((r) => r.amount)).toFixed(2)).toBe('1000.00');
    const revision = {
      reason: 'Customer requested quarterly dates',
      installmentCount: 2,
      intervalMonths: 3,
      firstInstallmentDate: '2091-01-31',
    };
    expect((await post(base + '/bookings/' + bid + '/reschedule').send(revision)).body.code).toBe(
      'DOWN_PAYMENT_REQUIRED',
    );
    const payment = await post(base + '/payments')
      .set('Idempotency-Key', randomUUID())
      .send({ bookingId: bid, amount: '250', method: 'CASH', paidAt: new Date().toISOString() });
    expect(payment.status, payment.text).toBe(201);
    const verify = (token: string) =>
      post(base + '/payments/' + payment.body.data.id + '/verify', token)
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'CLEARED', reason: 'Cash received' });
    expect((await verify('staff')).body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
    const cleared = await verify('other');
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.data.receipt.reference).toMatch(/^RCT-/);
    const journal = await db.journal.findFirstOrThrow({
      where: { sourceId: payment.body.data.id },
      include: { lines: true },
    });
    expect(sum(journal.lines.map((l) => l.debit)).eq(sum(journal.lines.map((l) => l.credit)))).toBe(
      true,
    );
    const revised = await post(base + '/bookings/' + bid + '/reschedule').send(revision);
    expect(revised.status, revised.text).toBe(200);
    const current = await db.installment.findMany({ where: { bookingId: bid, superseded: false } });
    expect(current.find((r) => r.id === rows[0]!.id)).toBeDefined();
    expect(current.find((r) => r.id === rows[1]!.id)).toBeDefined();
    expect(sum(current.map((r) => r.amount)).eq(decimal('1000'))).toBe(true);
    expect(await db.approval.count({ where: { projectId: pid } })).toBe(0);
    const reversed = await post(base + '/payments/' + payment.body.data.id + '/reverse').send({
      reason: 'Correct duplicate collection',
    });
    expect(reversed.status, reversed.text).toBe(200);
    expect(
      (await db.receipt.findUniqueOrThrow({ where: { paymentId: payment.body.data.id } }))
        .reversedAt,
    ).not.toBeNull();
    expect((await db.booking.findUniqueOrThrow({ where: { id: bid } })).status).toBe('CONFIRMED');
  });
});

describe('retired hold migration with existing records', () => {
  it('releases only unbooked properties and retains booking, payment and hold history', async () => {
    const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const unit = await db.unit.create({
      data: {
        projectId,
        number: 'MIGRATION-HOLD',
        type: 'APARTMENT',
        size: '5',
        measurementUnit: 'marla',
        price: '900',
        status: 'RESERVED',
      },
    });
    const hold = await db.reservation.create({
      data: {
        reference: 'MIGRATION-HOLD',
        unitId: unit.id,
        customerId: booking.customerId,
        createdBy: staffId,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await db.unit.update({ where: { id: booking.unitId }, data: { status: 'RESERVED' } });
    const before = {
      bookings: await db.booking.count(),
      payments: await db.payment.count(),
      receipts: await db.receipt.count(),
      journals: await db.journal.count(),
    };
    const sql = await readFile(
      'prisma/migrations/202610140001_simplified_sales/migration.sql',
      'utf8',
    );
    await embedded.exec(
      sql.slice(sql.indexOf('UPDATE "Reservation"'), sql.indexOf('-- Optional legacy links')),
    );
    expect((await db.reservation.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe(
      'CANCELLED',
    );
    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe('AVAILABLE');
    expect((await db.unit.findUniqueOrThrow({ where: { id: booking.unitId } })).status).toBe(
      'RESERVED',
    );
    expect(
      await db.unitHistory.count({
        where: { unitId: unit.id, reason: 'Unfinished hold closed when holds were retired' },
      }),
    ).toBe(1);
    expect({
      bookings: await db.booking.count(),
      payments: await db.payment.count(),
      receipts: await db.receipt.count(),
      journals: await db.journal.count(),
    }).toEqual(before);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).reservationId).toBe(
      booking.reservationId,
    );
  });
});
