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
import { expireReservations } from '../src/modules/sales/service.js';
import { pdfBuffer, generateArtifact } from '../src/jobs/artifacts.js';
import { buildOpenApi } from '../src/docs/openapi.js';
const app = createApp();
const api = request(app);
const pass = 'TestOnly-Strong-Password-192!';
let tokenA: string,
  tokenB: string,
  limitedToken: string,
  actorA: string,
  actorB: string,
  projectId: string,
  otherProjectId: string,
  customerId: string,
  buyerId: string,
  planVersionId: string,
  cashId: string;
let unitSequence = 0;
const root = () => `/api/v1/projects/${projectId}`;
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
  return post<{ id: string }>(
    root() + '/customers',
    { name, phone: '03001234567', identity: `T-${randomUUID()}` },
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
async function reserve(unitId: string) {
  return post<{ id: string }>(root() + '/reservations', { unitId, customerId }, tokenA, 201);
}
async function draft(price = '1000.00', dealerId?: string) {
  const u = await unit(price);
  const reservation = await reserve(u.id);
  const result = await post<{ booking: { id: string; total: string }; approval: { id: string } }>(
    root() + '/bookings',
    { reservationId: reservation.id, planVersionId, dealerId },
    tokenA,
    201,
  );
  return { ...result, unit: u };
}
async function approve(approvalId: string) {
  const approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
  return post(
    root() + `/approvals/${approvalId}/decide`,
    { decision: 'APPROVE', comment: 'Verified supporting records' },
    approval.requestedBy === actorB ? tokenA : tokenB,
  );
}
async function payment(bookingId: string, amount: string, method = 'CASH') {
  return data<{ id: string }>(
    await auth(api.post(root() + '/payments'))
      .set('Idempotency-Key', randomUUID())
      .send({
        bookingId,
        amount,
        method,
        paidAt: new Date().toISOString(),
        receivingAccountId: cashId,
      }),
    201,
  );
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
async function confirmed(price = '1000.00', dealerId?: string) {
  const b = await draft(price, dealerId);
  await clear((await payment(b.booking.id, price)).id);
  await approve(b.approval.id);
  await post(root() + `/bookings/${b.booking.id}/confirm`, { approvalId: b.approval.id }, tokenB);
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
  actorB = b.id;
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
      { code: 'PMS-TEST', name: 'Integration test project' },
      tokenA,
      201,
    )
  ).id;
  otherProjectId = (
    await post<{ id: string }>(
      '/api/v1/projects',
      { code: 'PMS-OTHER', name: 'Other project' },
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
  const plan = await post<{ versions: { id: string }[] }>(root() + '/payment-plans', {
    name: 'Two installments',
    schedule: [
      { label: 'Down payment', percent: '20', days: 0 },
      { label: 'Balance', percent: '80', months: 1 },
    ],
  });
  planVersionId = plan.versions[0]!.id;
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
  it('allows exactly one competing reservation and prevents cross-project customers', async () => {
    const u = await unit();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        auth(api.post(root() + '/reservations')).send({ unitId: u.id, customerId }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const other = await db.customer.findFirst({ where: { projectId: otherProjectId } });
    expect(other).toBeNull();
    const outside = await post<{ id: string }>(
      `/api/v1/projects/${otherProjectId}/customers`,
      { name: 'Other customer', phone: '03001111111', identity: 'OTHER-IDENTITY-1' },
      tokenA,
      201,
    );
    const free = await unit();
    expect(
      (
        await auth(api.post(root() + '/reservations')).send({
          unitId: free.id,
          customerId: outside.id,
        })
      ).status,
    ).toBe(404);
  });
  it('expires holds through the worker and can reserve them again', async () => {
    const u = await unit();
    const r = await reserve(u.id);
    await db.reservation.update({
      where: { id: r.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expireReservations();
    expect((await db.unit.findUniqueOrThrow({ where: { id: u.id } })).status).toBe('AVAILABLE');
    expect((await reserve(u.id)).id).not.toBe(r.id);
  });
  it('blocks confirmation without cleared down payment and prevents self approval', async () => {
    const b = await draft();
    const self = await auth(api.post(root() + `/approvals/${b.approval.id}/decide`)).send({
      decision: 'APPROVE',
      comment: 'Self approval attempt',
    });
    expect(self.status).toBe(403);
    await approve(b.approval.id);
    const confirm = await auth(api.post(root() + `/bookings/${b.booking.id}/confirm`), tokenB).send(
      { approvalId: b.approval.id },
    );
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('DOWN_PAYMENT_REQUIRED');
  });
  it('enforces approval data binding for discounts', async () => {
    const u = await unit();
    const approval = await post<{ id: string }>(root() + `/units/${u.id}/discount-requests`, {
      amount: '50',
    });
    expect(
      (
        await auth(api.post(root() + `/approvals/${approval.id}/decide`), limitedToken).send({
          decision: 'APPROVE',
          comment: 'Unauthorized',
        })
      ).status,
    ).toBe(403);
    await approve(approval.id);
    const r = await reserve(u.id);
    const res = await auth(api.post(root() + '/bookings')).send({
      reservationId: r.id,
      planVersionId,
      discount: '100',
      discountApprovalId: approval.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPROVAL_DATA_CHANGED');
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
    await approve(b.approval.id);
    await post(root() + `/bookings/${b.booking.id}/confirm`, { approvalId: b.approval.id }, tokenB);
    expect(
      (
        await auth(api.post(root() + `/bookings/${b.booking.id}/confirm`), tokenB).send({
          approvalId: b.approval.id,
        })
      ).status,
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
    const approval = await post<{ id: string }>(root() + `/payments/${p.id}/reversal-requests`);
    await approve(approval.id);
    await post(
      root() + `/payments/${p.id}/reverse`,
      { approvalId: approval.id, reason: 'Bank correction' },
      tokenB,
    );
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
      schedule: [{ label: 'Revised balance', amount: '800', dueDate: '2027-01-01' }],
    };
    const approval = await post<{ id: string }>(
      root() + `/bookings/${b.booking.id}/reschedule-requests`,
      revision,
    );
    await approve(approval.id);
    await post(
      root() + `/bookings/${b.booking.id}/reschedule`,
      { ...revision, approvalId: approval.id },
      tokenB,
    );
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
    const approval = await post<{ id: string }>(
      root() + `/payments/${original.id}/reversal-requests`,
    );
    await approve(approval.id);
    await post(
      root() + `/payments/${original.id}/reverse`,
      { approvalId: approval.id, reason: 'Replace original payment' },
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
    const approval = await post<{ id: string }>(root() + `/payments/${p.id}/reversal-requests`);
    await approve(approval.id);
    await post(
      root() + `/payments/${p.id}/reverse`,
      { approvalId: approval.id, reason: 'Correct recorded payment' },
      tokenB,
    );
    await expect(
      db.payment.update({ where: { id: p.id }, data: { status: 'CLEARED' } }),
    ).rejects.toThrow();
  });
});
describe('ownership, accounting and reporting', () => {
  it('retains seller history after an approved transfer with verified charges', async () => {
    const b = await confirmed();
    const ndc = await post<{ ndc: { id: string }; approval: { id: string } }>(root() + '/ndcs', {
      bookingId: b.booking.id,
      identityVerified: true,
      documentsVerified: true,
    });
    await approve(ndc.approval.id);
    await post(root() + `/ndcs/${ndc.ndc.id}/issue`, { approvalId: ndc.approval.id }, tokenB);
    const t = await post<{ transfer: { id: string }; approval: { id: string } }>(
      root() + '/transfers',
      { bookingId: b.booking.id, buyerId, ndcId: ndc.ndc.id, charges: '50' },
    );
    await approve(t.approval.id);
    expect(
      (
        await auth(api.post(root() + `/transfers/${t.transfer.id}/complete`), tokenB).send({
          approvalId: t.approval.id,
        })
      ).status,
    ).toBe(409);
    await post(
      root() + `/transfers/${t.transfer.id}/verify-fee`,
      { accountId: cashId, paymentReference: 'TRANSFER-BANK-1' },
      tokenB,
    );
    await post(
      root() + `/transfers/${t.transfer.id}/complete`,
      { approvalId: t.approval.id },
      tokenB,
    );
    const owners = await db.bookingOwner.findMany({ where: { bookingId: b.booking.id } });
    expect(owners).toHaveLength(2);
    expect(owners.find((o) => o.customerId === customerId)?.validTo).not.toBeNull();
    expect(owners.find((o) => o.customerId === buyerId)?.validTo).toBeNull();
  });
  it('limits staged refunds and prevents duplicate payout after cancellation', async () => {
    const b = await confirmed();
    const c = await post<{
      cancellation: { id: string; refundable: string };
      approval: { id: string };
    }>(root() + '/cancellations', {
      bookingId: b.booking.id,
      deduction: '100',
      reason: 'Customer cancellation',
    });
    expect(c.cancellation.refundable).toBe('900');
    await approve(c.approval.id);
    await post(
      root() + `/cancellations/${c.cancellation.id}/complete`,
      { approvalId: c.approval.id },
      tokenB,
    );
    expect((await db.unit.findUniqueOrThrow({ where: { id: b.unit.id } })).status).toBe(
      'AVAILABLE',
    );
    const refund = await post<{ refund: { id: string }; approval: { id: string } }>(
      root() + '/refunds',
      { cancellationId: c.cancellation.id, amount: '600' },
    );
    expect(
      (
        await auth(api.post(root() + '/refunds')).send({
          cancellationId: c.cancellation.id,
          amount: '301',
        })
      ).status,
    ).toBe(409);
    await approve(refund.approval.id);
    const body = {
      approvalId: refund.approval.id,
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
    const p = await post<{ possession: { id: string }; approval: { id: string } }>(
      root() + '/possessions',
      { bookingId: b.booking.id },
    );
    await approve(p.approval.id);
    const inspected = await post<{ snags: { id: string }[] }>(
      root() + `/possessions/${p.possession.id}/inspection`,
      { notes: 'Inspected property', snags: ['Repair entrance fitting'] },
    );
    expect(
      (
        await auth(api.post(root() + `/possessions/${p.possession.id}/handover`), tokenB).send({
          approvalId: p.approval.id,
        })
      ).status,
    ).toBe(409);
    await post(root() + `/snags/${inspected.snags[0]!.id}/resolve`);
    await post(
      root() + `/possessions/${p.possession.id}/handover`,
      { approvalId: p.approval.id },
      tokenB,
    );
    expect((await db.unit.findUniqueOrThrow({ where: { id: b.unit.id } })).status).toBe(
      'POSSESSED',
    );
  });
  it('prevents duplicate dealer settlement', async () => {
    const dealer = await post<{ id: string }>(root() + '/dealers', {
      name: 'Test dealer',
      phone: '03005555555',
      commissionPercent: '5',
    });
    const b = await confirmed('1000.00', dealer.id);
    const commission = await db.dealerCommission.findUniqueOrThrow({
      where: { bookingId: b.booking.id },
    });
    const approval = await db.approval.findFirstOrThrow({
      where: { entityId: commission.id, operation: 'COMMISSION' },
    });
    await approve(approval.id);
    const body = { approvalId: approval.id, accountId: cashId, paymentReference: 'COMMISSION-1' };
    await post(root() + `/commissions/${commission.id}/settle`, body, tokenB);
    expect(
      (await auth(api.post(root() + `/commissions/${commission.id}/settle`), tokenB).send(body))
        .status,
    ).toBe(409);
    expect(
      await db.journal.count({ where: { source: 'COMMISSION', sourceId: commission.id } }),
    ).toBe(1);
  });
  it('rejects unbalanced journals both in the API and at database commit', async () => {
    const accounts = await db.account.findMany({ where: { projectId }, take: 2 });
    const response = await auth(api.post(root() + '/journals/requests')).send({
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
    const bad = await auth(api.post(root() + '/documents')).attach(
      'file',
      Buffer.from('Not a PDF'),
      'fake.pdf',
    );
    expect(bad.status).toBe(422);
    const pdf = await pdfBuffer('Test document', 'Integration test content');
    const uploaded = data<{ id: string }>(
      await auth(api.post(root() + '/documents')).attach('file', pdf, 'test.pdf'),
      201,
    );
    const download = data<{ url: string }>(
      await auth(api.get(root() + `/documents/${uploaded.id}/download`)),
    );
    expect(download.url).toContain('X-Amz-Expires=120');
    expect(
      (await auth(api.get(`/api/v1/projects/${otherProjectId}/documents/${uploaded.id}/download`)))
        .status,
    ).toBe(404);
    const response = await fetch(download.url);
    expect(response.status).toBe(200);
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
      const response = await fetch(download.url);
      const bytes = Buffer.from(await response.arrayBuffer());
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
