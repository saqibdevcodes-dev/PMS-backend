import type { Express } from 'express';
import { z } from 'zod';
import { Prisma, UnitStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { db, transaction, lock } from '../../database/client.js';
import { endpoint, pageQuery, pagination, paged, uuid, password, id } from '../../common/http.js';
import { positiveMoney, money, decimal } from '../../common/money.js';
import { AppError, found, requireState } from '../../common/errors.js';
import { audit, reference, outbox } from '../../common/operations.js';
import { permissions } from '../../common/permissions.js';
import { identityHash, encrypt, decrypt } from '../../common/security.js';
import { passwordHash } from '../auth/service.js';
import { requireImage, requireGalleryImages, requireUnitImages } from '../images/service.js';
import { defaultAccounts } from '../finance/service.js';
import { scopedUnit, unitState } from '../inventory/service.js';
import { emailUser, welcomeUser, webLink } from '../../common/notifications.js';
import { setCustomerProfilePhoto } from '../portal/profile-photo.js';
import { generateCustomerPassword, queueCredentials } from '../portal/credentials.js';
import {
  customerDirectoryPage,
  customerGroups,
  withCustomerPortfolio,
  withUnitPortfolio,
} from './portfolio.js';

const projectBody = z
  .object({
    name: z.string().min(2).max(200),
    location: z.string().trim().min(2).max(300),
    description: z.string().max(4000).default(''),
    features: z.array(z.string().min(1).max(100)).max(30).default([]),
    featureImages: z
      .array(z.object({ feature: z.string().min(1).max(100), imageId: uuid }).strict())
      .max(30)
      .default([]),
    photoId: uuid.optional(),
    photoIds: z.array(uuid).max(5).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('PKR'),
    timezone: z
      .string()
      .refine((v) => DateTime.now().setZone(v).isValid)
      .default('Asia/Karachi'),
    ndcValidityDays: z.number().int().min(1).max(365).default(30),
  })
  .strict();
const unitFields = z
  .object({
    number: z.string().min(1).max(100),
    type: z.enum(['RESIDENTIAL_PLOT', 'COMMERCIAL_PLOT', 'APARTMENT', 'SHOP', 'OFFICE', 'OTHER']),
    typeDetails: z.string().trim().min(2).max(100).optional(),
    photoId: uuid.optional(),
    photoIds: z.array(uuid).max(5).optional(),
    featureImages: z
      .array(z.object({ feature: z.string().min(1).max(100), imageId: uuid }).strict())
      .max(30)
      .default([]),
    phase: z.string().max(100).optional(),
    block: z.string().max(100).optional(),
    tower: z.string().max(100).optional(),
    sector: z.string().max(100).optional(),
    floor: z.string().max(100).optional(),
    size: positiveMoney,
    measurementUnit: z.enum(['marla', 'kanal', 'sq ft', 'sq yd', 'sq m', 'acre', 'hectare']),
    features: z.array(z.string().max(100)).max(30).default([]),
    price: positiveMoney,
    charges: money.default('0'),
  })
  .strict();
const unitBody = unitFields.superRefine((v, ctx) => {
  if (v.type === 'OTHER' && !v.typeDetails)
    ctx.addIssue({
      code: 'custom',
      path: ['typeDetails'],
      message: 'Describe the property type.',
    });
});
export const customerBody = z
  .object({
    name: z.string().min(2).max(200),
    phone: z.string().min(6).max(30),
    email: z.email().optional(),
    address: z.string().max(1000).optional(),
    photoId: uuid.optional(),
    identity: z
      .string()
      .min(5)
      .max(40)
      .regex(/^[a-zA-Z0-9 -]+$/),
    identityType: z.enum(['CNIC', 'PASSPORT']).default('CNIC'),
    communicationConsent: z.boolean().default(false),
  })
  .strict();
const customerCreateBody = customerBody
  .extend({ email: z.email() })
  .superRefine((v, ctx) => {
    const normalized = v.identity.replace(/[ -]/g, '');
    if (v.identityType === 'CNIC' ? !/^\d{13}$/.test(normalized) : !/^[A-Za-z0-9]{6,20}$/.test(normalized))
      ctx.addIssue({
        code: 'custom',
        path: ['identity'],
        message: v.identityType === 'CNIC' ? 'Enter a 13-digit CNIC, for example 35202-1234567-1.' : 'Enter a passport number with 6–20 letters or digits.',
      });
  });
const publicCustomer = {
  id: true,
  projectId: true,
  reference: true,
  name: true,
  phone: true,
  email: true,
  address: true,
  photoId: true,
  identityLast4: true,
  identityType: true,
  communicationConsent: true,
  createdAt: true,
} satisfies Prisma.CustomerSelect;
export function foundationRoutes(app: Express) {
  endpoint(
    app,
    'get',
    '/projects',
    { permission: 'projects.read', summary: 'List assigned projects', query: pageQuery },
    async (ctx, _b, q) => {
      const where = {
        access: { some: { userId: ctx.actor.id } },
        ...(q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
      };
      const [items, total] = await Promise.all([
        db.project.findMany({ where, ...pagination(q), orderBy: { createdAt: q.sort } }),
        db.project.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    '/projects',
    {
      permission: 'projects.create',
      summary: 'Create project, account mappings and membership',
      body: projectBody,
      status: 201,
    },
    async (ctx, body) =>
      transaction(async (tx) => {
        const gallery = await requireGalleryImages(tx, ctx, body, 'PROJECT');
        for (const item of body.featureImages) {
          requireState(
            body.features.includes(item.feature),
            'FEATURE_IMAGE_MISMATCH',
            'Select the feature before adding its photo.',
            422,
          );
          await requireImage(tx, ctx, item.imageId, 'PROJECT');
        }
        // Counter and unique index protect concurrent project creation, including legacy codes.
        let code: string;
        do {
          code = await reference(tx, 'PRJ');
        } while (await tx.project.findUnique({ where: { code } }));
        const project = await tx.project.create({ data: { ...body, ...gallery, code } });
        await tx.userProjectAccess.create({
          data: { userId: ctx.actor.id, projectId: project.id },
        });
        await defaultAccounts(tx, project.id);
        await audit(tx, { ...ctx, projectId: project.id }, 'project.created', project.id);
        return project;
      }),
  );
  endpoint(
    app,
    'patch',
    '/projects/:projectId',
    {
      permission: 'projects.update',
      summary: 'Update project business rules',
      body: projectBody.partial().extend({
        photoId: uuid.nullable().optional(),
        description: projectBody.shape.description.removeDefault().optional(),
        features: projectBody.shape.features.removeDefault().optional(),
        featureImages: projectBody.shape.featureImages.removeDefault().optional(),
        currency: projectBody.shape.currency.removeDefault().optional(),
        timezone: projectBody.shape.timezone.removeDefault().optional(),
        ndcValidityDays: projectBody.shape.ndcValidityDays.removeDefault().optional(),
      }),
    },
    async (ctx, body) =>
      transaction(async (tx) => {
        await lock(tx, 'Project', ctx.projectId);
        const current = found(await tx.project.findUnique({ where: { id: ctx.projectId } }));
        const gallery = await requireGalleryImages(tx, ctx, body, 'PROJECT', current);
        for (const item of body.featureImages ?? []) {
          requireState(
            (body.features ?? current.features).includes(item.feature),
            'FEATURE_IMAGE_MISMATCH',
            'Select the feature before adding its photo.',
            422,
          );
          await requireImage(tx, ctx, item.imageId, 'PROJECT');
        }
        const project = await tx.project.update({
          where: { id: ctx.projectId },
          data: { ...body, ...gallery },
        });
        await audit(tx, ctx, 'project.updated', project.id, body);
        return project;
      }),
  );
  endpoint(
    app,
    'get',
    '/projects/:projectId',
    { permission: 'projects.read', summary: 'Project overview and setup progress' },
    async (ctx) => {
      const project = found(
        await db.project.findUnique({
          where: { id: ctx.projectId },
          include: { _count: { select: { units: true, plans: true } } },
        }),
      );
      const availableProperties = await db.unit.count({
        where: { projectId: ctx.projectId, status: 'AVAILABLE', price: { gt: 0 } },
      });
      return { ...project, availableProperties };
    },
  );
  endpoint(
    app,
    'patch',
    '/projects/:projectId/settings',
    {
      permission: 'projects.update',
      summary: 'Save project payment settings',
      body: z
        .object({
          downPaymentPercent: money.refine((v) => decimal(v).lte(100)),
          ndcValidityDays: z.number().int().min(1).max(365),
        })
        .strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const project = await tx.project.update({ where: { id: ctx.projectId }, data: b });
        await audit(tx, ctx, 'project.settings_updated', project.id, b);
        return project;
      }),
  );
  endpoint(
    app,
    'get',
    '/users',
    { permission: 'users.manage', summary: 'List users without credentials', query: pageQuery },
    async (_ctx, _b, q) => {
      const [items, total] = await Promise.all([
        db.user.findMany({
          where: {
            accountType: 'STAFF',
            ...(q.search
              ? {
                  OR: [
                    { name: { contains: q.search, mode: 'insensitive' } },
                    { email: { contains: q.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            name: true,
            email: true,
            active: true,
            photoId: true,
            roles: { include: { role: true } },
            projects: true,
          },
          ...pagination(q),
          orderBy: { createdAt: q.sort },
        }),
        db.user.count({
          where: {
            accountType: 'STAFF',
            ...(q.search
              ? {
                  OR: [
                    { name: { contains: q.search, mode: 'insensitive' } },
                    { email: { contains: q.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
          },
        }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    '/users',
    {
      permission: 'users.manage',
      summary: 'Create a user and assign roles and projects',
      status: 201,
      body: z
        .object({
          name: z.string().min(2).max(200),
          email: z.email().toLowerCase(),
          password,
          photoId: uuid,
          roleIds: z.array(uuid).max(20),
          projectIds: z.array(uuid).max(100),
        })
        .strict(),
    },
    async (ctx, b) => {
      requireState(
        ctx.actor.permissions.has('roles.manage'),
        'FORBIDDEN',
        'Role assignment requires roles.manage.',
        403,
      );
      const hashed = await passwordHash(b.password);
      return transaction(async (tx) => {
        await requireImage(tx, ctx, b.photoId, 'USER');
        const user = await tx.user.create({
          data: {
            name: b.name,
            email: b.email,
            passwordHash: hashed,
            photoId: b.photoId,
            roles: { create: b.roleIds.map((roleId) => ({ roleId })) },
            projects: { create: b.projectIds.map((projectId) => ({ projectId })) },
          },
          select: { id: true, name: true, email: true, active: true },
        });
        await audit(tx, ctx, 'user.created', user.id);
        await welcomeUser(tx, user.id);
        return user;
      });
    },
  );
  endpoint(
    app,
    'patch',
    '/users/:id',
    {
      permission: 'users.manage',
      summary: 'Activate or deactivate a user',
      body: z.object({ active: z.boolean() }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'User', id(req));
        requireState(
          id(req) !== ctx.actor.id,
          'SELF_DEACTIVATION',
          'You cannot deactivate your own account.',
        );
        const previous = found(
          await tx.user.findFirst({ where: { id: id(req), accountType: 'STAFF' } }),
        );
        const user = await tx.user.update({
          where: { id: id(req) },
          data: b,
          select: { id: true, active: true },
        });
        if (!b.active)
          await tx.session.updateMany({
            where: { userId: id(req) },
            data: { revokedAt: new Date() },
          });
        await audit(tx, ctx, 'user.activation', user.id, b);
        if (previous.active !== b.active)
          await emailUser(
            tx,
            user.id,
            b.active ? 'Your account has been enabled' : 'Your account has been disabled',
            b.active
              ? `The property office has enabled your account. Sign in: ${webLink(previous.accountType === 'CUSTOMER' ? '/portal/login' : '/login')}`
              : 'The property office has disabled your account and signed out your sessions. Contact the office if you need assistance.',
          );
        return user;
      }),
  );
  endpoint(
    app,
    'get',
    '/users/:id/sessions',
    { permission: 'users.manage', summary: 'View a user device session inventory' },
    async (_ctx, _b, _q, req) =>
      db.session.findMany({
        where: { userId: id(req), user: { accountType: 'STAFF' } },
        select: {
          id: true,
          platform: true,
          deviceId: true,
          createdAt: true,
          lastActivity: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
  );
  endpoint(
    app,
    'post',
    '/users/:id/revoke-sessions',
    { permission: 'users.manage', summary: 'Revoke all sessions for a user' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        found(await tx.user.findFirst({ where: { id: id(req), accountType: 'STAFF' } }));
        await tx.session.updateMany({
          where: { userId: id(req) },
          data: { revokedAt: new Date() },
        });
        await audit(tx, ctx, 'user.sessions_revoked', id(req));
        await emailUser(
          tx,
          id(req),
          'Your sessions have been signed out',
          'An administrator signed out all sessions for your account. Contact the property office if you did not expect this action.',
        );
        return { revoked: true };
      }),
  );
  endpoint(
    app,
    'post',
    '/users/:id/reset-password',
    { permission: 'users.manage', summary: 'Send user a password reset email' },
    async (_ctx, _b, _q, req) => {
      const user = found(await db.user.findFirst({ where: { id: id(req), accountType: 'STAFF' } }));
      const { forgotPassword } = await import('../auth/service.js');
      return forgotPassword(user.email);
    },
  );
  endpoint(
    app,
    'post',
    '/users/:id/access',
    {
      permission: 'roles.manage',
      summary: 'Replace user roles and project access',
      body: z
        .object({ roleIds: z.array(uuid).max(20), projectIds: z.array(uuid).max(100) })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        await lock(tx, 'User', id(req));
        found(await tx.user.findFirst({ where: { id: id(req), accountType: 'STAFF' } }));
        await tx.userRole.deleteMany({ where: { userId: id(req) } });
        await tx.userProjectAccess.deleteMany({ where: { userId: id(req) } });
        await tx.userRole.createMany({
          data: b.roleIds.map((roleId) => ({ roleId, userId: id(req) })),
          skipDuplicates: true,
        });
        await tx.userProjectAccess.createMany({
          data: b.projectIds.map((projectId) => ({ projectId, userId: id(req) })),
          skipDuplicates: true,
        });
        await audit(tx, ctx, 'user.access_changed', id(req), b);
        await emailUser(
          tx,
          id(req),
          'Your account access has changed',
          `An administrator updated your roles or project access. Sign in to review your current access: ${webLink()}`,
        );
        return { updated: true };
      }),
  );
  endpoint(
    app,
    'get',
    '/roles',
    { permission: 'roles.manage', summary: 'List roles and available permissions' },
    async () => ({
      roles: (
        await db.role.findMany({
          where: { name: { not: 'Dealer Coordinator' } },
          include: { permissions: true },
        })
      ).map((role) => ({
        ...role,
        permissions: role.permissions.filter(
          (p) => !/^(crm|reservations|dealers|commissions|approvals)\./.test(p.permissionKey),
        ),
      })),
      permissions: permissions.filter(
        (p) => !/^(crm|reservations|dealers|commissions|approvals)\./.test(p),
      ),
    }),
  );
  endpoint(
    app,
    'post',
    '/roles',
    {
      permission: 'roles.manage',
      summary: 'Create an editable permission-based role',
      body: z
        .object({
          name: z.string().min(2).max(100),
          permissions: z
            .array(
              z.enum(
                permissions.filter(
                  (key) => !/^(crm|reservations|dealers|commissions|approvals)\./.test(key),
                ),
              ),
            )
            .max(100),
        })
        .strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const role = await tx.role.create({
          data: {
            name: b.name,
            permissions: {
              create: [...new Set(b.permissions)].map((permissionKey) => ({ permissionKey })),
            },
          },
        });
        await audit(tx, ctx, 'role.created', role.id, b);
        return role;
      }),
  );
  endpoint(
    app,
    'patch',
    '/roles/:id',
    {
      permission: 'roles.manage',
      summary: 'Replace role permissions',
      body: z
        .object({
          permissions: z
            .array(
              z.enum(
                permissions.filter(
                  (key) => !/^(crm|reservations|dealers|commissions|approvals)\./.test(key),
                ),
              ),
            )
            .max(100),
        })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        found(await tx.role.findUnique({ where: { id: id(req) } }));
        await tx.rolePermission.deleteMany({ where: { roleId: id(req) } });
        await tx.rolePermission.createMany({
          data: [...new Set(b.permissions)].map((permissionKey) => ({
            roleId: id(req),
            permissionKey,
          })),
        });
        await audit(tx, ctx, 'role.permissions_changed', id(req), b);
        return { updated: true };
      }),
  );
  const root = '/projects/:projectId';
  endpoint(
    app,
    'post',
    root + '/units',
    {
      permission: 'inventory.create',
      summary: 'Create inventory unit',
      body: unitBody,
      status: 201,
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const gallery = await requireUnitImages(tx, ctx, b);
        const unit = await tx.unit.create({ data: { ...b, ...gallery, projectId: ctx.projectId } });
        await unitState(tx, ctx, unit.id, 'AVAILABLE', 'Inventory created');
        return unit;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/units/import',
    {
      permission: 'inventory.create',
      summary: 'Atomically import up to 500 inventory units',
      body: z.object({ units: z.array(unitBody).min(1).max(500) }).strict(),
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        const numbers = b.units.map(unit => unit.number);
        requireState(new Set(numbers).size === numbers.length, 'DUPLICATE_PROPERTY', 'The import contains duplicate property numbers.', 422);
        const existing = await tx.unit.findMany({ where: { projectId: ctx.projectId, number: { in: numbers } }, select: { number: true } });
        requireState(!existing.length, 'PROPERTY_ALREADY_EXISTS', `These property numbers already exist: ${existing.map(unit => unit.number).slice(0, 10).join(', ')}. Bulk import only adds new properties.`, 422);
        for (const u of b.units) {
          const gallery = await requireUnitImages(tx, ctx, u);
          const unit = await tx.unit.create({
            data: { ...u, ...gallery, projectId: ctx.projectId },
          });
          await unitState(tx, ctx, unit.id, 'AVAILABLE', 'Bulk import');
        }
        return { imported: b.units.length };
      }),
  );
  endpoint(
    app,
    'get',
    root + '/units',
    {
      permission: 'inventory.read',
      summary: 'Search inventory availability',
      query: pageQuery.extend({
        status: z.enum(UnitStatus).optional(),
        phase: z.string().optional(),
        type: z.string().optional(),
      }),
    },
    async (ctx, _b, q) => {
      const where: Prisma.UnitWhereInput = {
        projectId: ctx.projectId,
        status: q.status,
        phase: q.phase,
        type: q.type,
        ...(q.search ? { number: { contains: q.search, mode: 'insensitive' } } : {}),
      };
      const [items, total] = await Promise.all([
        db.unit.findMany({ where, ...pagination(q), orderBy: { number: q.sort } }),
        db.unit.count({ where }),
      ]);
      return paged(await withUnitPortfolio(ctx, items), total, q);
    },
  );
  endpoint(
    app,
    'get',
    root + '/units/:id',
    { permission: 'inventory.read', summary: 'Unit detail with price and status history' },
    async (ctx, _b, _q, req) => {
      const unit = found(
        await db.unit.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          include: { history: { orderBy: { createdAt: 'desc' }, take: 100 } },
        }),
      );
      return (await withUnitPortfolio(ctx, [unit]))[0];
    },
  );
  endpoint(
    app,
    'patch',
    root + '/units/:id',
    {
      permission: 'inventory.update',
      summary:
        'Update property details and up to five photos; price changes use the Change price action',
      body: unitFields.omit({ price: true, charges: true }).partial().extend({
        photoId: uuid.nullable().optional(),
        features: unitFields.shape.features.removeDefault().optional(),
        featureImages: unitFields.shape.featureImages.removeDefault().optional(),
      }),
    },
    async (ctx, body, _q, req) =>
      transaction(async (tx) => {
        const current = await scopedUnit(tx, ctx, id(req));
        requireState(['AVAILABLE', 'BLOCKED'].includes(current.status), 'UNIT_COMMITTED', 'Booked or sold property cannot be edited. Resolve the booking before changing property details.');
        requireState(
          (body.type ?? current.type) !== 'OTHER' ||
            Boolean(body.typeDetails ?? current.typeDetails),
          'PROPERTY_TYPE_REQUIRED',
          'Describe the property type.',
          422,
        );
        const gallery = await requireUnitImages(
          tx,
          ctx,
          {
            ...body,
            features: body.features ?? current.features,
            featureImages:
              body.featureImages ??
              z
                .array(z.object({ feature: z.string(), imageId: uuid }))
                .parse(current.featureImages),
          },
          current,
        );
        const unit = await tx.unit.update({
          where: { id: current.id },
          data: {
            ...body,
            ...gallery,
            ...((body.type ?? current.type) !== 'OTHER' ? { typeDetails: null } : {}),
          },
        });
        await audit(tx, ctx, 'inventory.updated', unit.id, body);
        return unit;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/units/:id/status',
    {
      permission: 'inventory.change_status',
      summary: 'Block or release uncommitted inventory',
      body: z
        .object({ status: z.enum(['AVAILABLE', 'BLOCKED']), reason: z.string().min(3).max(1000) })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const unit = await scopedUnit(tx, ctx, id(req));
        requireState(
          ['AVAILABLE', 'BLOCKED'].includes(unit.status),
          'ILLEGAL_UNIT_TRANSITION',
          'Only available or blocked units can be changed manually.',
        );
        return unitState(tx, ctx, unit.id, b.status, b.reason);
      }),
  );
  endpoint(
    app,
    'post',
    root + '/units/:id/price',
    {
      permission: 'inventory.change_price',
      summary: 'Apply property price with history',
      body: z.object({ price: positiveMoney, charges: money }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const unit = await scopedUnit(tx, ctx, id(req));
        requireState(
          ['AVAILABLE', 'BLOCKED'].includes(unit.status),
          'UNIT_COMMITTED',
          'Committed inventory prices cannot be changed.',
        );
        const result = await tx.unit.update({
          where: { id: unit.id },
          data: { price: b.price, charges: b.charges },
        });
        await unitState(tx, ctx, unit.id, unit.status, 'Property price change');
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/customers',
    {
      permission: 'customers.create',
      summary:
        'Create a customer and email automatically generated portal login credentials',
      body: customerCreateBody,
      status: 201,
    },
    async (ctx, b) => {
      const { identity: rawIdentity, ...fields } = b;
      const identity = rawIdentity.replace(/[ -]/g, '').toUpperCase();
      const portalPassword = generateCustomerPassword();
      const email = fields.email?.trim().toLowerCase();
      const nextHash = await passwordHash(portalPassword);
      const credentialsIssuedAt = new Date();
      return transaction(async (tx) => {
        await requireImage(tx, ctx, fields.photoId, 'CUSTOMER');
        let portalUserId: string | undefined;
        if (nextHash) {
          const emailUnavailable = () =>
            new AppError(
              409,
              'EMAIL_UNAVAILABLE',
              'This email already has an account. Use a separate email or invite the customer to link their existing account.',
            );
          if (await tx.user.findUnique({ where: { email: email! } })) throw emailUnavailable();
          try {
            const user = await tx.user.create({
              data: {
                name: fields.name,
                email: email!,
                passwordHash: nextHash,
                accountType: 'CUSTOMER',
                credentialsIssuedAt,
              },
            });
            portalUserId = user.id;
          } catch (error) {
            // A concurrent account creation must never replace or attach to that account.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
              throw emailUnavailable();
            throw error;
          }
        }
        const customer = await tx.customer.create({
          data: {
            ...fields,
            email,
            portalUserId,
            projectId: ctx.projectId,
            reference: await reference(tx, 'CUS'),
            identityEncrypted: encrypt(identity),
            identityHash: identityHash(identity),
            identityLast4: identity.slice(-4),
          },
          select: publicCustomer,
        });
        await audit(tx, ctx, 'customer.created', customer.id);
        if (portalUserId) {
          if (customer.photoId) await setCustomerProfilePhoto(tx, portalUserId, customer.photoId);
          await audit(tx, ctx, 'customer.portal_account_created', customer.id);
          await queueCredentials(tx, customer.id, portalPassword, credentialsIssuedAt);
        } else if (customer.email) {
          // A one-time registration confirmation is transactional, even without portal access.
          // Keep it independent of the optional customer property-update consent.
          const notification = await tx.notification.create({
            data: {
              customerId: customer.id,
              recipient: customer.email,
              channel: 'EMAIL',
              title: 'Welcome to Etihad Real Estate',
              body: `Hello ${customer.name},\n\nYour customer profile has been registered with Etihad Real Estate. Contact the property office for assistance or to request customer portal access.\n\nEtihad Real Estate`,
            },
          });
          await outbox(tx, 'customer-welcome', { notificationId: notification.id });
        }
        return customer;
      });
    },
  );
  endpoint(
    app,
    'get',
    root + '/customers',
    {
      permission: 'customers.read',
      summary: 'Search customers by name, phone or authorized identity',
      query: pageQuery.extend({
        identity: z.string().max(40).optional(),
        group: z.enum(customerGroups).optional(),
      }),
    },
    async (ctx, _b, q) => {
      if (q.identity)
        requireState(
          ctx.actor.permissions.has('customers.view_sensitive'),
          'FORBIDDEN',
          'Sensitive search permission is required.',
          403,
        );
      if (q.group)
        requireState(
          ctx.actor.permissions.has('bookings.read'),
          'FORBIDDEN',
          'Booking access is required to filter customer portfolios.',
          403,
        );
      if (ctx.actor.permissions.has('bookings.read')) {
        const index = await customerDirectoryPage(
          ctx,
          q,
          q.identity ? identityHash(q.identity) : undefined,
        );
        const customers = await db.customer.findMany({
          where: { projectId: ctx.projectId, id: { in: index.ids } },
          select: publicCustomer,
        });
        const byId = new Map(customers.map((c) => [c.id, c]));
        const items = index.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
        return {
          ...paged(await withCustomerPortfolio(ctx, items), index.total, q),
          groups: index.groups,
        };
      }
      const where: Prisma.CustomerWhereInput = {
        projectId: ctx.projectId,
        ...(q.identity ? { identityHash: identityHash(q.identity) } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { phone: { contains: q.search } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.customer.findMany({
          where,
          select: publicCustomer,
          ...pagination(q),
          orderBy: { createdAt: q.sort },
        }),
        db.customer.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'get',
    root + '/customers/:id',
    {
      permission: 'customers.read',
      summary: 'Customer profile, nominees and historical property ownership',
    },
    async (ctx, _b, _q, req) => {
      const customer = found(
        await db.customer.findFirst({
          where: { id: id(req), projectId: ctx.projectId },
          select: {
            ...publicCustomer,
            contacts: true,
            nominees: true,
            owners: {
              include: {
                booking: { select: { id: true, reference: true, status: true, total: true } },
              },
            },
          },
        }),
      );
      return (await withCustomerPortfolio(ctx, [customer]))[0];
    },
  );
  endpoint(
    app,
    'get',
    root + '/customers/:id/identity',
    { permission: 'customers.view_sensitive', summary: 'Reveal identity with audited access' },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const c = found(
          await tx.customer.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        await audit(tx, ctx, 'customer.identity_viewed', c.id);
        return { identity: decrypt(c.identityEncrypted) };
      }),
  );
  endpoint(
    app,
    'patch',
    root + '/customers/:id',
    {
      permission: 'customers.update',
      summary: 'Update non-identity customer contact details',
      body: customerBody
        .omit({ identity: true })
        .extend({ photoId: uuid.nullable().optional() })
        .partial(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const current = found(
          await tx.customer.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        // A portal photo is shared with the account and can originate in another
        // linked project. Keeping that existing photo must not fail contact edits.
        if (b.photoId !== current.photoId) await requireImage(tx, ctx, b.photoId, 'CUSTOMER');
        const result = await tx.customer.update({
          where: { id: id(req) },
          data: b,
          select: publicCustomer,
        });
        if (current.portalUserId && b.photoId !== undefined && b.photoId !== current.photoId)
          await setCustomerProfilePhoto(tx, current.portalUserId, b.photoId);
        await audit(tx, ctx, 'customer.updated', id(req));
        return result;
      }),
  );
  endpoint(
    app,
    'post',
    root + '/customers/:id/nominees',
    {
      permission: 'customers.update',
      summary: 'Add customer nominee',
      body: z
        .object({
          name: z.string().min(2).max(200),
          relationship: z.string().max(100),
          phone: z.string().max(30),
        })
        .strict(),
    },
    async (ctx, b, _q, req) => {
      found(await db.customer.findFirst({ where: { id: id(req), projectId: ctx.projectId } }));
      return db.customerNominee.create({ data: { ...b, customerId: id(req) } });
    },
  );
}
