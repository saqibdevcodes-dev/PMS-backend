import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { db, transaction } from '../src/database/client.js';
import { redis } from '../src/integrations/redis.js';
import { defaultAccounts } from '../src/modules/finance/service.js';
import { passwordHash, login } from '../src/modules/auth/service.js';
import { permissions } from '../src/common/permissions.js';
import {
  createBooking,
  unassignBookingOrUnit,
  createPayment,
} from '../src/modules/sales/service.js';
import { bookingInput } from '../src/modules/sales/payment-plan.js';
import { dealsProfitability } from '../src/modules/reports/service.js';
import { storage } from '../src/integrations/storage.js';
const app = createApp();
const api = request(app);
const password = 'Audit-Only-Password-123!';
let projectId: string,
  userId: string,
  customerId: string,
  buyerId: string,
  cashId: string,
  token: string,
  limitedToken: string;
const ctx = () => ({
  actor: {
    id: userId,
    sessionId: randomUUID(),
    accountType: 'STAFF' as const,
    permissions: new Set(permissions),
  },
  projectId,
  requestId: randomUUID(),
});
const root = () => `/api/v1/projects/${projectId}`;
async function booking(status: 'CONFIRMED' | 'DRAFT' = 'CONFIRMED') {
  const unit = await db.unit.create({
    data: {
      projectId,
      number: randomUUID(),
      type: 'RESIDENTIAL_PLOT',
      size: '5',
      measurementUnit: 'marla',
      price: '1000',
    },
  });
  const result = await createBooking(
    ctx(),
    bookingInput.parse({
      customerId,
      unitId: unit.id,
      paymentType: 'FULL_PAYMENT',
      confirm: status === 'CONFIRMED',
    }),
  );
  return { unit, booking: result.booking };
}
async function collected(bookingId: string) {
  return db.payment.create({
    data: {
      bookingId,
      payerId: customerId,
      amount: '1000',
      method: 'CASH',
      paidAt: new Date(),
      receivingAccountId: cashId,
      receivedBy: userId,
      status: 'CLEARED',
    },
  });
}
async function purchase(unitId?: string, status: 'DRAFT' | 'POSTED' = 'POSTED') {
  const vendor = await db.vendor.create({
    data: { projectId, name: 'Audit seller', category: 'SELLER', phone: '03001234567' },
  });
  const p = await db.propertyPurchase.create({
    data: {
      projectId,
      unitId,
      vendorId: vendor.id,
      reference: randomUUID(),
      title: 'Audit acquisition',
      location: 'Audit location',
      purchaseDate: new Date(),
      price: '500',
      total: '500',
      fileReference: randomUUID(),
      createdBy: userId,
      status: 'DRAFT',
    },
  });
  if (status === 'POSTED') {
    const res = await api
      .post(root() + `/property-purchases/${p.id}/post`)
      .set('Authorization', 'Bearer ' + token)
      .send({ expectedTotal: '500', expectedUpdatedAt: p.updatedAt.toISOString() });
    expect(res.status, res.text).toBe(200);
    return db.propertyPurchase.findUniqueOrThrow({ where: { id: p.id } });
  }
  return p;
}
beforeAll(async () => {
  await db.permission.createMany({
    data: permissions.map((key) => ({ key })),
    skipDuplicates: true,
  });
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.pathname.endsWith('_test')) throw new Error('Audit requires isolated test database');
  const hash = await passwordHash(password);
  const user = await db.user.create({
    data: {
      name: 'Audit administrator',
      email: `audit-${randomUUID()}@example.invalid`,
      passwordHash: hash,
    },
  });
  userId = user.id;
  const role = await db.role.create({
    data: {
      name: `Audit ${randomUUID()}`,
      permissions: { create: permissions.map((permissionKey) => ({ permissionKey })) },
    },
  });
  await db.userRole.create({ data: { userId, roleId: role.id } });
  const project = await transaction(async (tx) => {
    const p = await tx.project.create({
      data: { name: 'Final product audit', code: `AUD-${randomUUID().slice(0, 8)}` },
    });
    await defaultAccounts(tx, p.id);
    return p;
  });
  projectId = project.id;
  await db.userProjectAccess.create({ data: { userId, projectId } });
  const c = await db.customer.create({
    data: {
      projectId,
      name: 'Audit customer',
      phone: '03001234567',
      reference: randomUUID(),
      identityEncrypted: 'test',
      identityHash: randomUUID(),
      identityLast4: '1234',
    },
  });
  customerId = c.id;
  const b = await db.customer.create({
    data: {
      projectId,
      name: 'Audit buyer',
      phone: '03001234568',
      reference: randomUUID(),
      identityEncrypted: 'test',
      identityHash: randomUUID(),
      identityLast4: '5678',
    },
  });
  buyerId = b.id;
  cashId = (await db.account.findFirstOrThrow({ where: { projectId, code: '1000' } })).id;
  token = (await login({ email: user.email, password }, 'electron', randomUUID())).accessToken;
  const limited = await db.user.create({
    data: {
      name: 'Audit non-administrator',
      email: `limited-${randomUUID()}@example.invalid`,
      passwordHash: hash,
    },
  });
  const limitedRole = await db.role.create({
    data: {
      name: `Audit limited ${randomUUID()}`,
      permissions: { create: [{ permissionKey: 'bookings.cancel' }] },
    },
  });
  await db.userRole.create({ data: { userId: limited.id, roleId: limitedRole.id } });
  await db.userProjectAccess.create({ data: { userId: limited.id, projectId } });
  limitedToken = (await login({ email: limited.email, password }, 'electron', randomUUID()))
    .accessToken;
});
afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
  storage.destroy();
});
it('guards against duplicate refund reservations when a cancelled booking is unassigned again', async () => {
  const f = await booking();
  await collected(f.booking.id);
  await unassignBookingOrUnit(ctx(), { bookingId: f.booking.id }, { refundMode: 'FULL' });
  await expect(
    unassignBookingOrUnit(ctx(), { bookingId: f.booking.id }, { refundMode: 'FULL' }),
  ).rejects.toMatchObject({ code: 'BOOKING_CANCELLED' });
  const refunds = await db.refund.findMany({
    where: { cancellation: { bookingId: f.booking.id } },
  });
  expect(refunds).toHaveLength(1);
  expect(refunds.reduce((s, r) => s + Number(r.amount), 0)).toBe(1000);
});
it('guards against unassignment of possessed property', async () => {
  const f = await booking();
  await db.unit.update({ where: { id: f.unit.id }, data: { status: 'POSSESSED' } });
  await expect(
    unassignBookingOrUnit(ctx(), { bookingId: f.booking.id }, { refundMode: 'FULL' }),
  ).rejects.toMatchObject({ code: 'OWNERSHIP_CONFLICT' });
  expect((await db.unit.findUniqueOrThrow({ where: { id: f.unit.id } })).status).toBe('POSSESSED');
});
it('guards against unassignment leaving a pending transfer while making the unit available', async () => {
  const f = await booking();
  await db.unit.update({ where: { id: f.unit.id }, data: { status: 'TRANSFER_PENDING' } });
  const tr = await db.transfer.create({
    data: {
      reference: randomUUID(),
      bookingId: f.booking.id,
      buyerId,
      charges: '0',
      requestedBy: userId,
    },
  });
  await expect(
    unassignBookingOrUnit(ctx(), { bookingId: f.booking.id }, { refundMode: 'FULL' }),
  ).rejects.toMatchObject({ code: 'OWNERSHIP_CONFLICT' });
  expect((await db.transfer.findUniqueOrThrow({ where: { id: tr.id } })).status).toBe('PENDING');
  expect((await db.unit.findUniqueOrThrow({ where: { id: f.unit.id } })).status).toBe(
    'TRANSFER_PENDING',
  );
});
it('guards against payment-bearing booking deletion failing at immutable-payment database trigger', async () => {
  const f = await booking();
  await collected(f.booking.id);
  const res = await api
    .delete(root() + `/bookings/${f.booking.id}`)
    .set('Authorization', 'Bearer ' + token)
    .send({ password });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('BOOKING_HAS_HISTORY');
  expect(await db.booking.findUnique({ where: { id: f.booking.id } })).not.toBeNull();
});
it('guards against a non-administrator permanently deleting a booking with their own password', async () => {
  const f = await booking('DRAFT');
  const res = await api
    .delete(root() + `/bookings/${f.booking.id}`)
    .set('Authorization', 'Bearer ' + limitedToken)
    .send({ password });
  expect(res.status).toBe(403);
  expect(await db.booking.findUnique({ where: { id: f.booking.id } })).not.toBeNull();
});
it('guards against listing bypass for a possessed property', async () => {
  const f = await booking();
  await db.unit.update({ where: { id: f.unit.id }, data: { status: 'POSSESSED' } });
  const p = await purchase(f.unit.id);
  const res = await api
    .post(root() + `/property-purchases/${p.id}/list-for-sale`)
    .set('Authorization', 'Bearer ' + token)
    .send({ askingPrice: '1500' });
  expect(res.status).toBe(409);
  expect((await db.unit.findUniqueOrThrow({ where: { id: f.unit.id } })).status).toBe('POSSESSED');
});
it('guards against draft bookings inflating realized-profit and sold-count totals', async () => {
  const f = await booking('DRAFT');
  const p = await purchase(f.unit.id);
  const data = await dealsProfitability(projectId);
  const deal = data.deals.find((x) => x.id === p.id)!;
  expect(deal.dealStatus).toBe('BOOKED');
  expect(deal.netProfit).toBeNull();
  expect(deal.salePrice).toBeNull();
  expect(deal.projectedProfit).toBe('500.00');
});
it('guards against posted investment being labelled available while its unit remains blocked', async () => {
  const unit = await db.unit.create({
    data: {
      projectId,
      number: randomUUID(),
      type: 'RESIDENTIAL_PLOT',
      size: '5',
      measurementUnit: 'marla',
      price: '500',
      status: 'BLOCKED',
    },
  });
  const p = await purchase(unit.id);
  const result = await dealsProfitability(projectId);
  const deal = result.deals.find((x) => x.id === p.id)!;
  expect(deal.dealStatus).toBe('UNLISTED');
  expect(deal.unit?.status).toBe('BLOCKED');
});
it('guards against property deletion with cancelled booking timing out due to nested transactions', async () => {
  const f = await booking('DRAFT');
  await unassignBookingOrUnit(ctx(), { bookingId: f.booking.id }, { refundMode: 'FULL' });
  const start = Date.now();
  const res = await api
    .delete(root() + `/units/${f.unit.id}`)
    .set('Authorization', 'Bearer ' + token)
    .send({ password });
  expect(res.status, res.text).toBe(200);
  expect(Date.now() - start).toBeLessThan(5000);
  expect(await db.unit.findUnique({ where: { id: f.unit.id } })).toBeNull();
});
it('guards against unauthenticated customer financial disclosure through a customer UUID', async () => {
  const res = await api.get('/api/v1/verify/customer/' + customerId);
  expect(res.status).toBe(200);
  expect(res.body.data.valid).toBe(true);
  expect(res.body.data.financial).toBeUndefined();
  expect(res.body.data.payments).toBeUndefined();
  expect(res.body.data.name).toBeUndefined();
  expect(res.body.data.identityLast4).toBeUndefined();
});
it('guards against public printed customer codes being rejected before lookup', async () => {
  const res = await api.get('/api/v1/verify/customer/MEM-' + customerId.slice(0, 8));
  expect(res.status).toBe(200);
  expect(res.body.data.valid).toBe(true);
});
it('guards against a customer reader discovering a customer name in an unassigned project', async () => {
  const p = await db.project.create({
    data: { name: 'Unassigned audit project', code: 'PRIVATE-' + randomUUID().slice(0, 8) },
  });
  const c = await db.customer.create({
    data: {
      projectId: p.id,
      name: 'Private audit customer',
      email: `private-${randomUUID()}@example.invalid`,
      phone: '03001234567',
      reference: randomUUID(),
      identityEncrypted: 'test',
      identityHash: randomUUID(),
      identityLast4: '1234',
    },
  });
  const res = await api
    .get(root() + '/customers/check-email')
    .query({ email: c.email })
    .set('Authorization', 'Bearer ' + token);
  expect(res.status).toBe(200);
  expect(res.body.data.existingMember).toBeNull();
  expect(res.body.data.exists).toBe(true);
});
it('rejects unsupported query limits rather than returning incomplete option data', async () => {
  const res = await api
    .get(root() + '/property-purchases?limit=250')
    .set('Authorization', 'Bearer ' + token);
  expect(res.status).toBe(422);
});
it('guards against a cheque being cleared immediately when entered by a Super Admin', async () => {
  const f = await booking();
  const context = ctx();
  Object.assign(context.actor, { isSuperAdmin: true });
  const payment = await createPayment(
    context,
    {
      bookingId: f.booking.id,
      amount: '1000',
      method: 'CHEQUE',
      paidAt: new Date().toISOString(),
      transactionReference: 'AUDIT-UNCLEARED-CHEQUE',
    },
    randomUUID(),
  );
  expect(payment.status).toBe('PENDING');
  expect(
    await db.journal.findUnique({
      where: { source_sourceId: { source: 'PAYMENT', sourceId: payment.id } },
    }),
  ).toBeNull();
});
it('guards against purchase reversal while the linked property has an active sale booking', async () => {
  const f = await booking();
  const p = await purchase(f.unit.id);
  const res = await api
    .post(root() + `/property-purchases/${p.id}/void`)
    .set('Authorization', 'Bearer ' + token)
    .send({ reason: 'Audit reversal of committed purchase' });
  expect(res.status).toBe(409);
  expect((await db.propertyPurchase.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
    'POSTED',
  );
  expect((await db.booking.findUniqueOrThrow({ where: { id: f.booking.id } })).status).toBe(
    'CONFIRMED',
  );
});
it('keeps the intentionally retired dealer API unavailable', async () => {
  const res = await api
    .post(root() + '/dealers')
    .set('Authorization', 'Bearer ' + token)
    .send({ name: 'Audit quick dealer', phone: '03001234567', commissionPercent: '0' });
  expect(res.status).toBe(404);
});
it('guards against changing currency after real financial postings without converting history', async () => {
  const before = await db.payment.findFirstOrThrow({ where: { booking: { unit: { projectId } } } });
  const res = await api
    .patch(`/api/v1/projects/${projectId}`)
    .set('Authorization', 'Bearer ' + token)
    .send({ currency: 'USD' });
  expect(res.status).toBe(409);
  expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).currency).toBe('PKR');
  expect((await db.payment.findUniqueOrThrow({ where: { id: before.id } })).amount.toFixed(2)).toBe(
    before.amount.toFixed(2),
  );
});
it('guards against accepting arbitrary text with a docx extension as a valid Word document', async () => {
  const res = await api
    .post(root() + '/documents')
    .set('Authorization', 'Bearer ' + token)
    .field('name', 'Audit invalid document')
    .field('audience', 'STAFF_ONLY')
    .attach('file', Buffer.from('This is plain text, not an Office document.'), 'audit.docx');
  expect(res.status).toBe(422);
});
it('summarizes more than 1000 installments and pages every selected-day obligation', async () => {
  const f = await booking('DRAFT');
  // Other cases create installments due today. Keep this volume fixture on its own date.
  const day = '2099-08-15';
  await db.installment.updateMany({
    where: { bookingId: f.booking.id },
    data: { superseded: true },
  });
  await db.installment.createMany({
    data: Array.from({ length: 1100 }, (_, index) => ({
      bookingId: f.booking.id,
      sequence: index + 1,
      version: 2,
      label: 'Scale installment ' + index,
      dueDate: new Date(day),
      amount: '0.01',
    })),
  });
  const month = await api
    .get(root() + '/installment-calendar')
    .query({ from: day, to: day })
    .set('Authorization', 'Bearer ' + token);
  expect(month.status, month.text).toBe(200);
  expect(month.body.data.days[0].total).toBe(1100);
  const last = await api
    .get(root() + '/installment-calendar/day')
    .query({ date: day, status: 'unpaid', page: 44, limit: 25 })
    .set('Authorization', 'Bearer ' + token);
  expect(last.status, last.text).toBe(200);
  expect(last.body.data.pagination.total).toBe(1100);
  expect(last.body.data.items).toHaveLength(25);
  const denied = await api
    .get(root() + '/installment-calendar')
    .query({ from: day, to: day })
    .set('Authorization', 'Bearer ' + limitedToken);
  expect(denied.status).toBe(403);
});
it('never publishes financial or identity details on a public property-file verification', async () => {
  const f = await booking();
  const response = await api.get('/api/v1/verify/file/' + f.booking.reference);
  expect(response.status).toBe(200);
  expect(response.body.data.valid).toBe(true);
  for (const key of ['total', 'customerName', 'customerIdentityLast4', 'customerId'])
    expect(response.body.data).not.toHaveProperty(key);
});
it('does not resolve a dangerously short customer identifier', async () => {
  const response = await api.get('/api/v1/verify/customer/' + customerId.slice(0, 1));
  expect(response.status).toBe(422);
});
