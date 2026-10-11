import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
import { createPayment } from '../src/modules/sales/service.js';
import { signedDownload, putObject } from '../src/integrations/storage.js';
import { login } from '../src/modules/auth/service.js';

const app = express();
app.use(express.json(), (_req, res, next) => {
  res.locals.requestId = randomUUID();
  next();
});
imageRoutes(app);
foundationRoutes(app);
crmRoutes(app);
documentRoutes(app);
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

describe('private record images and guided form contracts', () => {
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
      code: 'PHOTO',
      photoId,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.photoId).toBe(photoId);
    const preview = await get('/images/' + photoId);
    expect(preview.status).toBe(200);
    expect(preview.body.data.expiresIn).toBe(120);
    expect((await get('/images/' + photoId, 'other')).status).toBe(404);
    expect((await get('/images/' + photoId, 'customer')).status).toBe(403);
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
  it('requires dealer and new staff photos and validates their purpose', async () => {
    const dealer = { name: 'Dealer', phone: '03001234567', commissionPercent: '2' };
    expect((await post(`/projects/${projectId}/dealers`).send(dealer)).status).toBe(422);
    const photoId = await upload('DEALER', projectId);
    expect((await post(`/projects/${projectId}/dealers`).send({ ...dealer, photoId })).status).toBe(
      200,
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
      identity: randomUUID(),
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
    expect((await get('/images/' + photoId, 'customer')).status).toBe(403);
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
    expect(saved.portalUserId).toBeNull();
  });
  it('rejects customer photos with the wrong purpose or project on creation and editing', async () => {
    const path = `/projects/${projectId}/customers`;
    const body = { name: 'Photo scope customer', phone: '03001234567', identity: randomUUID() };
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
      expect((await post(path).send({ ...body, identity: randomUUID(), photoId })).body.code).toBe(
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
    const pass = 'Customer-Password-123';
    const email = 'new-portal@example.invalid';
    const created = await post(`/projects/${projectId}/customers`).send({
      name: 'New portal customer',
      phone: '03001234567',
      identity: randomUUID(),
      email: email.toUpperCase(),
      password: pass,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.email).toBe(email);
    expect(created.text).not.toMatch(/password|hash|portalUserId|accessToken|refreshToken/);
    const customer = await db.customer.findUniqueOrThrow({ where: { id: created.body.data.id } });
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(customer.portalUserId).toBe(user.id);
    expect(user.accountType).toBe('CUSTOMER');
    expect(
      await db.notification.count({
        where: { userId: user.id, channel: 'EMAIL', title: 'Welcome to Etihad Real Estate' },
      }),
    ).toBe(1);
    expect(user.passwordHash).not.toBe(pass);
    expect(await argon2.verify(user.passwordHash, pass)).toBe(true);
    expect(await db.userRole.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.userProjectAccess.count({ where: { userId: user.id } })).toBe(0);
    const signedIn = await login({ email, password: pass }, 'web', randomUUID());
    expect((await db.session.findUniqueOrThrow({ where: { id: signedIn.sessionId } })).userId).toBe(
      user.id,
    );
    const audit = await db.auditLog.findMany({ where: { entityId: customer.id } });
    expect(audit.map((entry) => entry.action)).toContain('customer.portal_account_created');
    expect(JSON.stringify(audit)).not.toMatch(/Customer-Password-123|passwordHash|argon2/);
  });
  it('emails lead creation, changed assignees, follow-ups and recovery assignments to the assignee', async () => {
    const path = `/projects/${projectId}`;
    const created = await post(path + '/leads').send({
      name: 'Assigned lead',
      phone: '03001234567',
      source: 'Website',
      assignedTo: staffId,
    });
    expect(created.status, created.text).toBe(200);
    const leadId = created.body.data.id;
    const patch = (assignedTo: string) =>
      request(app)
        .patch('/api/v1' + path + '/leads/' + leadId)
        .set('Authorization', 'Bearer staff')
        .send({ assignedTo });
    expect((await patch(staffId)).status).toBe(200);
    expect(
      await db.notification.count({
        where: { userId: staffId, title: 'New lead assigned to you', channel: 'EMAIL' },
      }),
    ).toBe(1);
    expect(await db.notification.count({ where: { title: 'Lead reassigned to you' } })).toBe(0);
    // Cross-project assignees cannot receive either the assignment or an email.
    expect((await patch(otherId)).status).toBe(404);
    await db.userProjectAccess.create({ data: { userId: otherId, projectId } });
    expect((await patch(otherId)).status).toBe(200);
    expect(
      await db.notification.count({
        where: { userId: otherId, title: 'Lead reassigned to you', channel: 'EMAIL' },
      }),
    ).toBe(1);
    expect(
      (
        await post(path + '/leads/' + leadId + '/activities').send({
          kind: 'FOLLOW_UP',
          notes: 'Call the lead',
          scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        })
      ).status,
    ).toBe(200);
    expect(
      await db.notification.count({
        where: { userId: otherId, title: 'New scheduled lead activity', channel: 'EMAIL' },
      }),
    ).toBe(1);
    const recovery = await post(path + '/recovery-cases').send({ bookingId, assignedTo: staffId });
    expect(recovery.status, recovery.text).toBe(200);
    expect(
      await db.notification.count({
        where: { userId: staffId, title: 'New recovery case assigned to you', channel: 'EMAIL' },
      }),
    ).toBe(1);
  });
  it('requires a valid password, email and portal permission; passwords cannot be patched', async () => {
    const path = `/projects/${projectId}/customers`;
    const body = { name: 'Portal validation', phone: '03001234567', identity: randomUUID() };
    const password = 'Customer-Password-123';
    expect((await post(path).send({ ...body, password })).status).toBe(422);
    expect(
      (await post(path).send({ ...body, email: 'weak@example.invalid', password: 'weak' })).status,
    ).toBe(422);
    expect(
      (await post(path, 'creator').send({ ...body, email: 'forbidden@example.invalid', password }))
        .status,
    ).toBe(403);
    expect(await db.user.findUnique({ where: { email: 'forbidden@example.invalid' } })).toBeNull();
    const customer = await post(path, 'creator').send(body);
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
  it('sends a transactional welcome for customer profile registration without portal access or optional communication consent', async () => {
    const email = 'profile-welcome@example.invalid';
    const response = await post(`/projects/${projectId}/customers`).send({
      name: 'New customer profile',
      phone: '03001234567',
      identity: randomUUID(),
      email,
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.data.communicationConsent).toBe(false);
    const notification = await db.notification.findFirstOrThrow({
      where: { recipient: email, title: 'Welcome to Etihad Real Estate', channel: 'EMAIL' },
    });
    expect(notification.customerId).toBe(response.body.data.id);
    expect(notification.body).toContain('request customer portal access');
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(
      await db.outbox.count({
        where: {
          kind: 'customer-welcome',
          payload: { path: ['notificationId'], equals: notification.id },
        },
      }),
    ).toBe(1);
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
    const body = { name: 'Existing account', phone: '03001234567', identity: randomUUID() };
    const pass = 'Customer-Password-123';
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
        identity: randomUUID(),
        email: account.email,
        password: pass,
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
    const rejected = await post(path).send({ ...body, email, password: pass });
    expect(rejected.status).not.toBe(201);
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });
  it('requires proof for every non-cash payment and details for Other, preserving retries', async () => {
    const body = {
      bookingId,
      amount: '25.00',
      paidAt: new Date(Date.now() - 1000).toISOString(),
      receivingAccountId: accountId,
    };
    for (const method of ['BANK_TRANSFER', 'CHEQUE', 'PAY_ORDER', 'OTHER'])
      await expect(
        createPayment(context(), { ...body, method }, randomUUID()),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROOF_REQUIRED' });
    const proofImageId = await upload('PAYMENT', projectId);
    await expect(
      createPayment(context(), { ...body, method: 'OTHER', proofImageId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_DETAILS_REQUIRED' });
    const wrong = await upload('UNIT', projectId);
    await expect(
      createPayment(
        context(),
        { ...body, method: 'BANK_TRANSFER', proofImageId: wrong },
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
