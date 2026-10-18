import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request, { type Response } from 'supertest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app.js';
import { db, transaction } from '../src/database/client.js';
import { redis } from '../src/integrations/redis.js';
import { ensureStorage, storage } from '../src/integrations/storage.js';
import { passwordHash } from '../src/modules/auth/service.js';
import { permissions } from '../src/common/permissions.js';
import { pdfBuffer, generateArtifact } from '../src/jobs/artifacts.js';
import { buildOpenApi } from '../src/docs/openapi.js';
import { env } from '../src/config/env.js';
const app = createApp();
const api = request(app);
const pass = 'TestOnly-Strong-Password-192!';
let tokenA: string,
  tokenB: string,
  limitedToken: string,
  actorA: string,
  projectId: string,
  otherProjectId: string,
  customerId: string,
  buyerId: string,
  cashId: string;
let unitSequence = 0;
const root = () => `/api/v1/projects/${projectId}`;
async function downloadFile(url: string) {
  if (env.STORAGE_DRIVER === 's3') {
    const response = await fetch(url);
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  const parsed = new URL(url);
  const response = await api
    .get(parsed.pathname + parsed.search)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
      res.on('error', done);
    });
  return { status: response.status, bytes: response.body as Buffer };
}
function auth(req: request.Test, token = tokenA) {
  return req.set('Authorization', `Bearer ${token}`);
}
function data<T = Record<string, unknown>>(response: Response, status = 200): T {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.body.success).toBe(true);
  return response.body.data as T;
}
async function post<T = Record<string, unknown>>(
  path: string,
  body: unknown = {},
  token = tokenA,
  status = 200,
): Promise<T> {
  return data<T>(await auth(api.post(path), token).send(body as object), status);
}
async function login(email: string) {
  return data<{ accessToken: string; refreshToken: string; sessionId: string }>(
    await api
      .post('/api/v1/auth/native/login')
      .send({ email, password: pass, platform: 'electron', deviceId: 'test-device' }),
  );
}
async function customer(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cnicDigits = String(Math.floor(10000000 + Math.random() * 90000000));
  return post<{ id: string }>(
    root() + '/customers',
    {
      name,
      phone: '03001234567',
      email: `${slug}-${randomUUID()}@example.invalid`,
      identity: `35202${cnicDigits}`,
    },
    tokenA,
    201,
  );
}
async function unit(price = '1000.00') {
  return post<{ id: string }>(
    root() + '/units',
    {
      number: `U-${++unitSequence}`,
      type: 'RESIDENTIAL_PLOT',
      size: '5',
      measurementUnit: 'marla',
      price,
    },
    tokenA,
    201,
  );
}
async function draft(price = '1000.00') {
  const u = await unit(price);
  const result = await post<{ booking: { id: string; total: string } }>(
    root() + '/bookings',
    {
      unitId: u.id,
      customerId,
      paymentType: 'INSTALLMENTS',
      downPayment: new Prisma.Decimal(price).mul('0.2').toFixed(2),
      installmentCount: 1,
      intervalMonths: 1,
      firstInstallmentDate: '2090-01-01',
    },
    tokenA,
    201,
  );
  return { ...result, unit: u };
}
async function payment(
  bookingId: string,
  amount: string,
  method = 'CASH',
  transactionReference = method === 'CASH' ? undefined : `REF-${randomUUID().slice(0, 8)}`,
) {
  const proofImageId =
    method === 'CASH' || method === 'CHEQUE' ? undefined : await recordImage('PAYMENT');
  return data<{ id: string }>(
    await auth(api.post(root() + '/payments'))
      .set('Idempotency-Key', randomUUID())
      .send({
        bookingId,
        amount,
        method,
        transactionReference,
        proofImageId,
        paidAt: new Date().toISOString(),
        receivingAccountId: cashId,
      }),
    201,
  );
}
async function recordImage(purpose: 'PAYMENT') {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=',
    'base64',
  );
  return data<{ id: string }>(
    await auth(api.post('/api/v1/images'))
      .field('purpose', purpose)
      .field('projectId', projectId)
      .attach('file', png, 'photo.png'),
    201,
  ).id;
}
async function clear(paymentId: string) {
  return data<{
    id: string;
    receipt: { id: string };
    allocations: { installmentId: string; amount: string }[];
  }>(
    await auth(api.post(root() + `/payments/${paymentId}/verify`), tokenB)
      .set('Idempotency-Key', randomUUID())
      .send({ decision: 'CLEARED', reason: 'Bank credit checked' }),
  );
}
async function confirmed(price = '1000.00') {
  const b = await draft(price);
  await post(root() + `/bookings/${b.booking.id}/confirm`, {}, tokenB);
  await clear((await payment(b.booking.id, price)).id);
  return b;
}
beforeAll(async () => {
  await ensureStorage();
  const existing = await redis.keys('pms:limit:*');
  if (existing.length) await redis.del(...existing);
  await db.permission.createMany({
    data: permissions.map((key) => ({ key })),
    skipDuplicates: true,
  });
  const role = await db.role.create({
    data: {
      name: 'Test Administrator',
      permissions: { create: permissions.map((permissionKey) => ({ permissionKey })) },
    },
  });
  const limited = await db.role.create({
    data: {
      name: 'Test Reader',
      permissions: {
        create: [{ permissionKey: 'inventory.read' }, { permissionKey: 'projects.read' }],
      },
    },
  });
  const hash = await passwordHash(pass);
  const a = await db.user.create({
    data: {
      email: 'admin-a@test.invalid',
      name: 'Admin A',
      passwordHash: hash,
      roles: { create: { roleId: role.id } },
    },
  });
  actorA = a.id;
  const b = await db.user.create({
    data: {
      email: 'admin-b@test.invalid',
      name: 'Admin B',
      passwordHash: hash,
      roles: { create: { roleId: role.id } },
    },
  });
  const reader = await db.user.create({
    data: {
      email: 'reader@test.invalid',
      name: 'Reader',
      passwordHash: hash,
      roles: { create: { roleId: limited.id } },
    },
  });
  tokenA = (await login(a.email)).accessToken;
  tokenB = (await login(b.email)).accessToken;
  limitedToken = (await login(reader.email)).accessToken;
  projectId = (
    await post<{ id: string }>(
      '/api/v1/projects',
      { name: 'Integration test project', location: 'Lahore' },
      tokenA,
      201,
    )
  ).id;
  otherProjectId = (
    await post<{ id: string }>(
      '/api/v1/projects',
      { name: 'Other project', location: 'Karachi' },
      tokenA,
      201,
    )
  ).id;
  await db.userProjectAccess.createMany({
    data: [
      { userId: b.id, projectId },
      { userId: reader.id, projectId },
    ],
  });
  customerId = (await customer('Customer A')).id;
  buyerId = (await customer('Buyer B')).id;
  cashId = (
    await db.account.findUniqueOrThrow({ where: { projectId_code: { projectId, code: '1000' } } })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
  storage.destroy();
});
describe('authentication and authorization', () => {
  it('returns only access token to web JavaScript and requires a trusted Origin', async () => {
    const login = await api
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'admin-a@test.invalid', password: pass });
    const body = data<Record<string, unknown>>(login);
    expect(body.refreshToken).toBeUndefined();
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(login.headers['set-cookie'])).toContain('Path=/api/v1/auth/refresh');
    expect(
      (await api.post('/api/v1/auth/login').send({ email: 'admin-a@test.invalid', password: pass }))
        .status,
    ).toBe(403);
  });
  it('rotates native tokens and revokes the entire family when an old token is replayed', async () => {
    const initial = await login('admin-a@test.invalid');
    const rotated = data<{ accessToken: string; refreshToken: string }>(
      await api.post('/api/v1/auth/native/refresh').send({ refreshToken: initial.refreshToken }),
    );
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    const replay = await api
      .post('/api/v1/auth/native/refresh')
      .send({ refreshToken: initial.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REPLAY');
    expect((await auth(api.get('/api/v1/auth/me'), rotated.accessToken)).status).toBe(401);
  });
  it('keeps web and native refresh contracts separate', async () => {
    const initial = await login('admin-a@test.invalid');
    expect(
      (
        await api
          .post('/api/v1/auth/refresh')
          .set('Origin', 'http://localhost:3000')
          .set('Cookie', `pms_refresh=${initial.refreshToken}`)
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (await api.post('/api/v1/auth/native/refresh').send({ refreshToken: initial.refreshToken }))
        .status,
    ).toBe(200);
  });
  it('revokes a device session on logout', async () => {
    const session = await login('admin-b@test.invalid');
    await post('/api/v1/auth/logout', {}, session.accessToken);
    expect((await auth(api.get('/api/v1/auth/me'), session.accessToken)).status).toBe(401);
  });
  it('enforces permissions and project isolation on lists and details', async () => {
    expect((await auth(api.post(root() + '/units'), limitedToken).send({})).status).toBe(403);
    expect(
      (await auth(api.get(`/api/v1/projects/${otherProjectId}/units`), limitedToken)).status,
    ).toBe(404);
    const u = await unit();
    expect((await auth(api.get(`/api/v1/projects/${otherProjectId}/units/${u.id}`))).status).toBe(
      404,
    );
  });
  it('masks encrypted customer identity and rejects mass assignment', async () => {
    const customer = data<Record<string, unknown>>(
      await auth(api.get(root() + `/customers/${customerId}`)),
    );
    expect(customer.identityEncrypted).toBeUndefined();
    expect(customer.identityHash).toBeUndefined();
    expect(customer.identityLast4).toBeDefined();
    const row = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(row.identityEncrypted).not.toContain('TEST-');
    const invalid = await auth(api.patch(root() + `/customers/${customerId}`)).send({
      name: 'Changed',
      identityHash: 'attack',
    });
    expect(invalid.status).toBe(422);
  });
});
describe('inventory, booking and collections', () => {
  it('allows exactly one competing booking and prevents cross-project customers', async () => {
    const u = await unit();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        auth(api.post(root() + '/bookings')).send({
          unitId: u.id,
          customerId,
          paymentType: 'FULL_PAYMENT',
          confirm: true,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const other = await db.customer.findFirst({ where: { projectId: otherProjectId } });
    expect(other).toBeNull();
    const outside = await post<{ id: string }>(
      `/api/v1/projects/${otherProjectId}/customers`,
      {
        name: 'Other customer',
        phone: '03001111111',
        email: `other-${randomUUID()}@example.invalid`,
        identity: `35202${String(Math.floor(10000000 + Math.random() * 90000000))}`,
      },
      tokenA,
      201,
    );
    const free = await unit();
    expect(
      (
        await auth(api.post(root() + '/bookings')).send({
          unitId: free.id,
          customerId: outside.id,
          paymentType: 'FULL_PAYMENT',
        })
      ).status,
    ).toBe(404);
  });
  it('retires hold and approval APIs and permits confirmation before payment', async () => {
    expect((await auth(api.post(root() + '/reservations')).send({})).status).toBe(404);
    expect((await auth(api.get(root() + '/approvals'))).status).toBe(404);
    const b = await draft();
    expect(
      (await auth(api.post(root() + `/bookings/${b.booking.id}/confirm`), limitedToken).send({}))
        .status,
    ).toBe(403);
    await post(root() + `/bookings/${b.booking.id}/confirm`, {}, tokenB);
    expect(await db.payment.count({ where: { bookingId: b.booking.id } })).toBe(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.booking.id } })).status).toBe(
      'CONFIRMED',
    );
  });
  it('rejects an excessive discount and allows an authorized direct discount', async () => {
    const u = await unit();
    const body = { unitId: u.id, customerId, paymentType: 'FULL_PAYMENT', discount: '1001' };
    expect((await auth(api.post(root() + '/bookings')).send(body)).status).toBe(422);
    const result = await post<{ booking: { total: string } }>(
      root() + '/bookings',
      { ...body, discount: '100', confirm: true },
      tokenA,
      201,
    );
    expect(result.booking.total).toBe('900');
  });
  it('deduplicates simultaneous payment creation and rejects changed idempotency payloads', async () => {
    const b = await draft();
    const key = randomUUID();
    const body = {
      bookingId: b.booking.id,
      amount: '125.50',
      method: 'CASH',
      paidAt: new Date().toISOString(),
      receivingAccountId: cashId,
    };
    const responses = await Promise.all(
      [1, 2].map(() =>
        auth(api.post(root() + '/payments'))
          .set('Idempotency-Key', key)
          .send(body),
      ),
    );
    responses.forEach((r) => data(r, 201));
    expect(responses[0]!.body.data.id).toBe(responses[1]!.body.data.id);
    expect(await db.payment.count({ where: { bookingId: b.booking.id } })).toBe(1);
    expect(
      (
        await auth(api.post(root() + '/payments'))
          .set('Idempotency-Key', key)
          .send({ ...body, amount: '126' })
      ).status,
    ).toBe(409);
  });
  it('allocates partial cleared payments, issues one receipt and confirms only once', async () => {
    const b = await draft();
    const p = await payment(b.booking.id, '250');
    expect(await db.receipt.count({ where: { paymentId: p.id } })).toBe(0);
    expect(
      (
        await auth(api.post(root() + `/payments/${p.id}/verify`))
          .set('Idempotency-Key', randomUUID())
          .send({ decision: 'CLEARED', reason: 'Self verification' })
      ).status,
    ).toBe(403);
    const cleared = await clear(p.id);
    const installments = await db.installment.findMany({
      where: { bookingId: b.booking.id },
      orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
    });
    expect(
      cleared.allocations.map((a) => ({
        installmentId: a.installmentId,
        amount: String(a.amount),
      })),
    ).toEqual([
      { installmentId: installments[0]!.id, amount: '200' },
      { installmentId: installments[1]!.id, amount: '50' },
    ]);
    expect(cleared.receipt.id).toBeTruthy();
    const detail = data<{ position: { outstanding: string } }>(
      await auth(api.get(root() + `/bookings/${b.booking.id}`)),
    );
    expect(detail.position.outstanding).toBe('750.00');
    await post(root() + `/bookings/${b.booking.id}/confirm`, {}, tokenB);
    expect(
      (await auth(api.post(root() + `/bookings/${b.booking.id}/confirm`), tokenB).send({})).status,
    ).toBe(409);
  });
  it('rejects bounced cheques without allocations or cleared receipts', async () => {
    const b = await draft();
    const p = await payment(b.booking.id, '200', 'CHEQUE');
    data(
      await auth(api.post(root() + `/payments/${p.id}/verify`), tokenB)
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'BOUNCED', reason: 'Bank rejected cheque' }),
    );
    expect(await db.receipt.count({ where: { paymentId: p.id } })).toBe(0);
    expect(await db.paymentAllocation.count({ where: { paymentId: p.id } })).toBe(0);
  });
  it('reverses cleared payments atomically without deleting history', async () => {
    const b = await draft();
    const p = await payment(b.booking.id, '300');
    await clear(p.id);
    await post(root() + `/payments/${p.id}/reverse`, { reason: 'Bank correction' }, tokenB);
    const rows = await db.paymentAllocation.findMany({ where: { paymentId: p.id } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.reversedAt)).toBe(true);
    expect(
      (await db.receipt.findUniqueOrThrow({ where: { paymentId: p.id } })).reversedAt,
    ).not.toBeNull();
    expect(
      await db.journal.count({ where: { reversalOf: { source: 'PAYMENT', sourceId: p.id } } }),
    ).toBe(1);
  });
  it('reschedules only wholly unpaid installments and retains paid rows', async () => {
    const b = await draft();
    await clear((await payment(b.booking.id, '200')).id);
    const original = await db.installment.findMany({
      where: { bookingId: b.booking.id },
      orderBy: { sequence: 'asc' },
    });
    const revision = {
      reason: 'Customer requested extended terms',
      installmentCount: 1,
      intervalMonths: 1,
      firstInstallmentDate: '2091-01-01',
    };
    await post(root() + `/bookings/${b.booking.id}/reschedule`, { ...revision }, tokenB);
    expect(
      (await db.installment.findUniqueOrThrow({ where: { id: original[0]!.id } })).superseded,
    ).toBe(false);
    expect(
      (await db.installment.findUniqueOrThrow({ where: { id: original[1]!.id } })).superseded,
    ).toBe(true);
    expect(await db.scheduleRevision.count({ where: { bookingId: b.booking.id } })).toBe(1);
  });
  it('reallocates existing advance credit after a reversal without posting another journal', async () => {
    const b = await draft();
    const original = await payment(b.booking.id, '1000');
    await clear(original.id);
    const advance = await payment(b.booking.id, '1000');
    expect((await clear(advance.id)).allocations).toHaveLength(0);
    await post(
      root() + `/payments/${original.id}/reverse`,
      { reason: 'Replace original payment' },
      tokenB,
    );
    const journals = await db.journal.count({ where: { projectId } });
    const receipts = await db.receipt.count({ where: { paymentId: advance.id } });
    await post(root() + `/payments/${advance.id}/allocate-advance`, {}, tokenB);
    await post(root() + `/payments/${advance.id}/allocate-advance`, {}, tokenB);
    const detail = data<{ position: { outstanding: string; unallocated: string } }>(
      await auth(api.get(root() + `/bookings/${b.booking.id}`)),
    );
    expect(detail.position).toMatchObject({ outstanding: '0.00', unallocated: '0.00' });
    expect(await db.journal.count({ where: { projectId } })).toBe(journals);
    expect(await db.receipt.count({ where: { paymentId: advance.id } })).toBe(receipts);
    expect(
      (
        await auth(
          api.post(`/api/v1/projects/${otherProjectId}/payments/${advance.id}/allocate-advance`),
          tokenB,
        )
      ).status,
    ).toBe(404);
  });
  it('prevents changing or deleting recorded payment facts and reopening reversed payments', async () => {
    const b = await draft();
    const p = await payment(b.booking.id, '100');
    await expect(
      db.payment.update({ where: { id: p.id }, data: { amount: '101' } }),
    ).rejects.toThrow();
    await expect(
      db.payment.update({ where: { id: p.id }, data: { payerId: buyerId } }),
    ).rejects.toThrow();
    await expect(db.payment.delete({ where: { id: p.id } })).rejects.toThrow();
    await clear(p.id);
    await post(
      root() + `/payments/${p.id}/reverse`,
      { reason: 'Correct recorded payment' },
      tokenB,
    );
    await expect(
      db.payment.update({ where: { id: p.id }, data: { status: 'CLEARED' } }),
    ).rejects.toThrow();
  });
});
import { transferChecks, possessionChecks, handoverReceipt } from './ownership-fixtures.js';
describe('ownership, accounting and reporting', () => {
  it('retains seller history after a direct transfer with verified charges', async () => {
    const b = await confirmed();
    const ndc = await post<{ ndc: { id: string } }>(root() + '/ndcs', {
      bookingId: b.booking.id,
      identityVerified: true,
      documentsVerified: true,
    });
    await post(root() + `/ndcs/${ndc.ndc.id}/issue`, {}, tokenB);
    const t = await post<{ transfer: { id: string } }>(root() + '/transfers', {
      bookingId: b.booking.id,
      buyerId,
      verification: transferChecks,
      charges: '50',
    });
    expect(
      (await auth(api.post(root() + `/transfers/${t.transfer.id}/complete`), tokenB).send({}))
        .status,
    ).toBe(409);
    await post(
      root() + `/transfers/${t.transfer.id}/verify-fee`,
      { accountId: cashId, paymentReference: 'TRANSFER-BANK-1' },
      tokenB,
    );
    await post(root() + `/transfers/${t.transfer.id}/complete`, {}, tokenB);
    const owners = await db.bookingOwner.findMany({ where: { bookingId: b.booking.id } });
    expect(owners).toHaveLength(2);
    expect(owners.find((o) => o.customerId === customerId)?.validTo).not.toBeNull();
    expect(owners.find((o) => o.customerId === buyerId)?.validTo).toBeNull();
  });
  it('limits staged refunds and prevents duplicate payout after cancellation', async () => {
    const b = await confirmed();
    const c = await post<{
      cancellation: { id: string; refundable: string };
    }>(root() + '/cancellations', {
      bookingId: b.booking.id,
      deduction: '100',
      reason: 'Customer cancellation',
    });
    expect(c.cancellation.refundable).toBe('900');
    await post(root() + `/cancellations/${c.cancellation.id}/complete`, {}, tokenB);
    expect((await db.unit.findUniqueOrThrow({ where: { id: b.unit.id } })).status).toBe(
      'AVAILABLE',
    );
    const refund = await post<{ refund: { id: string } }>(root() + '/refunds', {
      cancellationId: c.cancellation.id,
      amount: '600',
    });
    expect(
      (
        await auth(api.post(root() + '/refunds')).send({
          cancellationId: c.cancellation.id,
          amount: '301',
        })
      ).status,
    ).toBe(409);
    const body = {
      accountId: cashId,
      paymentReference: 'REFUND-BANK-1',
    };
    await post(root() + `/refunds/${refund.refund.id}/pay`, body, tokenB);
    expect(
      (await auth(api.post(root() + `/refunds/${refund.refund.id}/pay`), tokenB).send(body)).status,
    ).toBe(409);
  });
  it('requires inspection and resolved snags before handover', async () => {
    const b = await confirmed();
    const p = await post<{ possession: { id: string } }>(root() + '/possessions', {
      bookingId: b.booking.id,
      verification: possessionChecks,
    });
    const inspected = await post<{ snags: { id: string }[] }>(
      root() + `/possessions/${p.possession.id}/inspection`,
      { notes: 'Inspected property', snags: ['Repair entrance fitting'] },
    );
    expect(
      (
        await auth(api.post(root() + `/possessions/${p.possession.id}/handover`), tokenB).send(
          handoverReceipt,
        )
      ).status,
    ).toBe(409);
    await post(root() + `/snags/${inspected.snags[0]!.id}/resolve`);
    await post(root() + `/possessions/${p.possession.id}/handover`, handoverReceipt, tokenB);
    expect((await db.unit.findUniqueOrThrow({ where: { id: b.unit.id } })).status).toBe(
      'POSSESSED',
    );
  });
  it('retires dealers and commission settlement without creating new commissions', async () => {
    expect((await auth(api.get(root() + '/dealers'))).status).toBe(404);
    expect(
      (await auth(api.post(root() + '/commissions/' + randomUUID() + '/settle')).send({})).status,
    ).toBe(404);
    const b = await confirmed();
    expect(await db.dealerCommission.count({ where: { bookingId: b.booking.id } })).toBe(0);
  });
  it('rejects unbalanced journals both in the API and at database commit', async () => {
    const accounts = await db.account.findMany({ where: { projectId }, take: 2 });
    const response = await auth(api.post(root() + '/journals')).send({
      description: 'Invalid entry',
      postedAt: new Date().toISOString(),
      lines: [
        { accountId: accounts[0]!.id, debit: '10', credit: '0' },
        { accountId: accounts[1]!.id, debit: '0', credit: '9' },
      ],
    });
    expect(response.status).toBe(422);
    const period = await db.accountingPeriod.findFirstOrThrow({ where: { projectId } });
    await expect(
      transaction((tx) =>
        tx.journal.create({
          data: {
            projectId,
            periodId: period.id,
            reference: randomUUID(),
            source: 'TEST',
            sourceId: randomUUID(),
            description: 'Invalid raw insertion',
            createdBy: actorA,
            postedAt: new Date(),
            lines: {
              create: [
                { accountId: accounts[0]!.id, debit: 10, credit: 0 },
                { accountId: accounts[1]!.id, debit: 0, credit: 9 },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('prevents editing posted journal and append-only audit records', async () => {
    const journal = await db.journal.findFirstOrThrow({ where: { projectId } });
    await expect(
      db.journal.update({ where: { id: journal.id }, data: { description: 'Tamper' } }),
    ).rejects.toThrow();
    const log = await db.auditLog.findFirstOrThrow({ where: { projectId } });
    await expect(db.auditLog.delete({ where: { id: log.id } })).rejects.toThrow();
  });
  it('prevents adding even balanced lines to an already committed journal', async () => {
    const journal = await db.journal.findFirstOrThrow({
      where: { projectId },
      include: { lines: true },
    });
    await expect(
      transaction((tx) =>
        tx.journalLine.createMany({
          data: [
            {
              journalId: journal.id,
              accountId: journal.lines[0]!.accountId,
              debit: '10',
              credit: '0',
            },
            {
              journalId: journal.id,
              accountId: journal.lines[1]!.accountId,
              debit: '0',
              credit: '10',
            },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect(await db.journalLine.count({ where: { journalId: journal.id } })).toBe(
      journal.lines.length,
    );
  });
  it('reconciles dashboard collections and trial balance to source records', async () => {
    await redis.del(`pms:dashboard:${projectId}:`);
    const dashboard = data<{ verifiedCollections: string }>(
      await auth(api.get(root() + '/dashboard')),
    );
    const payments = await db.payment.aggregate({
      where: { booking: { unit: { projectId } }, status: 'CLEARED' },
      _sum: { amount: true },
    });
    expect(dashboard.verifiedCollections).toBe(payments._sum.amount!.toFixed(2));
    const report = data<{ rows: { debit: string; credit: string }[] }>(
      await auth(api.get(root() + '/reports?kind=trial-balance')),
    );
    const totals = report.rows.reduce(
      (a, r) => ({ debit: a.debit.plus(r.debit), credit: a.credit.plus(r.credit) }),
      { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) },
    );
    expect(totals.debit.eq(totals.credit)).toBe(true);
    const balanceSheet = data<{
      rows: { type: string; code: string }[];
      summary: { assets: string; liabilities: string; equity: string; balanced: boolean };
    }>(await auth(api.get(root() + '/reports?kind=balance-sheet')));
    expect(balanceSheet.summary.balanced).toBe(true);
    expect(
      new Prisma.Decimal(balanceSheet.summary.assets).eq(
        new Prisma.Decimal(balanceSheet.summary.liabilities).plus(balanceSheet.summary.equity),
      ),
    ).toBe(true);
    expect(balanceSheet.rows.some((row) => ['REVENUE', 'EXPENSE'].includes(row.type))).toBe(false);
    expect(balanceSheet.rows.some((row) => row.code === 'CURRENT_EARNINGS')).toBe(true);
  });
  it('rejects posting into a locked accounting period', async () => {
    const period = await db.accountingPeriod.findFirstOrThrow({
      where: { projectId: otherProjectId },
    });
    await post(`/api/v1/projects/${otherProjectId}/accounting-periods/${period.id}/lock`);
    const accounts = await db.account.findMany({ where: { projectId: otherProjectId }, take: 2 });
    await expect(
      transaction((tx) =>
        tx.journal.create({
          data: {
            projectId: otherProjectId,
            periodId: period.id,
            reference: randomUUID(),
            source: 'TEST',
            sourceId: randomUUID(),
            description: 'Closed period',
            createdBy: actorA,
            postedAt: new Date(),
            lines: {
              create: [
                { accountId: accounts[0]!.id, debit: 10, credit: 0 },
                { accountId: accounts[1]!.id, debit: 0, credit: 10 },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
describe('private storage, exports and API contracts', () => {
  it('paginates vendor records beyond 100 without leaking another project', async () => {
    const prefix = 'Pagination-' + randomUUID();
    await db.vendor.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        projectId,
        name: `${prefix}-${String(index).padStart(3, '0')}`,
        phone: '03001234567',
      })),
    });
    await db.vendor.create({
      data: { projectId: otherProjectId, name: prefix + '-external', phone: '03001234567' },
    });
    const first = data<{
      items: { id: string }[];
      pagination: { total: number; totalPages: number };
    }>(await auth(api.get(root() + `/vendors?limit=100&sort=asc&search=${prefix}`)));
    const second = data<{ items: { id: string }[] }>(
      await auth(api.get(root() + `/vendors?limit=100&page=2&sort=asc&search=${prefix}`)),
    );
    expect(first.pagination).toMatchObject({ total: 105, totalPages: 2 });
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(105);
  });
  it('checks actual upload type and prevents cross-project document downloads', async () => {
    const bad = await auth(api.post(root() + '/documents'))
      .field('name', 'Invalid document')
      .attach('file', Buffer.from('Not a PDF'), 'fake.pdf');
    expect(bad.status).toBe(422);
    const pdf = await pdfBuffer('Test document', 'Integration test content');
    const uploaded = data<{ id: string }>(
      await auth(api.post(root() + '/documents'))
        .field('name', 'Test document')
        .attach('file', pdf, 'test.pdf'),
      201,
    );
    const download = data<{ url: string }>(
      await auth(api.get(root() + `/documents/${uploaded.id}/download`)),
    );
    expect(download.url).toContain(
      env.STORAGE_DRIVER === 's3' ? 'X-Amz-Expires=120' : '/api/v1/files?token=',
    );
    expect(
      (await auth(api.get(`/api/v1/projects/${otherProjectId}/documents/${uploaded.id}/download`)))
        .status,
    ).toBe(404);
    const response = await downloadFile(download.url);
    expect(response.status).toBe(200);
    expect(response.bytes).toEqual(pdf);
  });
  it('generates real XLSX and PDF report artifacts with private download URLs', async () => {
    for (const format of ['xlsx', 'pdf']) {
      const job = await post<{ id: string }>(
        root() + '/reports/exports',
        { report: { kind: 'inventory' }, format },
        tokenA,
        202,
      );
      await generateArtifact(job.id);
      const download = data<{ url: string }>(
        await auth(api.get(root() + `/jobs/${job.id}/download`)),
      );
      const response = await downloadFile(download.url);
      expect(response.status).toBe(200);
      const bytes = response.bytes;
      expect(bytes.subarray(0, format === 'pdf' ? 4 : 2).toString()).toBe(
        format === 'pdf' ? '%PDF' : 'PK',
      );
      expect((await auth(api.get(root() + `/jobs/${job.id}/download`), tokenB)).status).toBe(404);
    }
  });
  it('returns standard error envelopes and complete endpoint inventory', async () => {
    const invalid = await auth(api.get(root() + '/units?page=0'));
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
      meta: { requestId: expect.any(String) },
    });
    const spec = buildOpenApi();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(90);
    expect(spec.paths['/auth/native/refresh']).toBeDefined();
    expect(spec.paths['/projects/{projectId}/payments']).toBeDefined();
    expect((await api.get('/health/ready')).status).toBe(200);
  });
});
