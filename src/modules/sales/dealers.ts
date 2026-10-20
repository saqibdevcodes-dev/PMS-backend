import type { Express } from 'express';
import { z } from 'zod';
import { db, transaction } from '../../database/client.js';
import { endpoint, uuid, id, paginationQuery, pagination, paged } from '../../common/http.js';
import { positiveMoney, sum } from '../../common/money.js';
import { found, requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { requireImage } from '../images/service.js';

const root = '/projects/:projectId';

export function dealerRoutes(app: Express) {
  endpoint(
    app,
    'get',
    root + '/dealers',
    {
      permission: 'dealers.read',
      summary: 'List dealers and sales performance for the project',
      query: paginationQuery.extend({
        search: z.string().max(200).optional(),
        active: z.enum(['true', 'false']).optional(),
      }),
    },
    async (ctx, _b, q) => {
      const where = {
        projectId: ctx.projectId,
        ...(q.active !== undefined ? { active: q.active === 'true' } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' as const } },
                { phone: { contains: q.search } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        db.dealer.findMany({
          where,
          include: {
            allocations: { select: { unitId: true } },
            bookings: {
              where: { status: 'CONFIRMED' },
              select: { id: true, total: true },
            },
            commissions: { select: { amount: true, status: true } },
          },
          ...pagination(q),
          orderBy: [{ createdAt: q.sort }, { id: q.sort }],
        }),
        db.dealer.count({ where }),
      ]);

      const formatted = items.map((d) => {
        const salesTotal = sum(d.bookings.map((b) => b.total));
        const commissionTotal = sum(d.commissions.map((c) => c.amount));
        const settledCommission = sum(
          d.commissions.filter((c) => c.status === 'COMPLETED').map((c) => c.amount),
        );
        return {
          id: d.id,
          name: d.name,
          phone: d.phone,
          active: d.active,
          commissionPercent: d.commissionPercent.toFixed(2),
          photoId: d.photoId,
          createdAt: d.createdAt.toISOString(),
          assignedProperties: d.allocations.length,
          soldProperties: d.bookings.length,
          totalSalesValue: salesTotal.toFixed(2),
          totalCommission: commissionTotal.toFixed(2),
          commissionPaid: settledCommission.toFixed(2),
          commissionPending: commissionTotal.minus(settledCommission).toFixed(2),
        };
      });

      return paged(formatted, total, q);
    },
  );

  endpoint(
    app,
    'post',
    root + '/dealers',
    {
      permission: 'dealers.manage',
      summary: 'Register a dealer / agent for property sales and allocations',
      body: z
        .object({
          name: z.string().trim().min(2).max(200),
          phone: z.string().trim().min(6).max(30),
          commissionPercent: positiveMoney.default('0'),
          photoId: uuid.optional(),
        })
        .strict(),
      status: 201,
    },
    async (ctx, b) =>
      transaction(async (tx) => {
        if (b.photoId) await requireImage(tx, ctx, b.photoId, 'DEALER');
        const dealer = await tx.dealer.create({
          data: {
            projectId: ctx.projectId,
            name: b.name,
            phone: b.phone,
            commissionPercent: b.commissionPercent,
            photoId: b.photoId,
          },
        });
        await audit(tx, ctx, 'dealer.created', dealer.id);
        return dealer;
      }),
  );

  endpoint(
    app,
    'get',
    root + '/dealers/:id',
    {
      permission: 'dealers.read',
      summary: 'Get dealer detail with property allocations and commission history',
    },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const dealer = found(
          await tx.dealer.findFirst({
            where: { id: id(req), projectId: ctx.projectId },
            include: {
              allocations: {
                include: {
                  unit: {
                    select: {
                      id: true,
                      number: true,
                      type: true,
                      size: true,
                      measurementUnit: true,
                      price: true,
                      status: true,
                      phase: true,
                      block: true,
                    },
                  },
                },
              },
              bookings: {
                select: {
                  id: true,
                  reference: true,
                  total: true,
                  status: true,
                  confirmedAt: true,
                  customer: { select: { id: true, name: true, phone: true } },
                  unit: { select: { id: true, number: true, type: true } },
                },
                orderBy: { createdAt: 'desc' },
              },
              commissions: {
                select: {
                  id: true,
                  bookingId: true,
                  amount: true,
                  status: true,
                  settledAt: true,
                  paymentReference: true,
                  booking: { select: { reference: true } },
                },
                orderBy: { id: 'desc' },
              },
            },
          }),
        );

        const salesTotal = sum(
          dealer.bookings.filter((b) => b.status === 'CONFIRMED').map((b) => b.total),
        );
        const commissionTotal = sum(dealer.commissions.map((c) => c.amount));
        const settledCommission = sum(
          dealer.commissions.filter((c) => c.status === 'COMPLETED').map((c) => c.amount),
        );

        return {
          id: dealer.id,
          name: dealer.name,
          phone: dealer.phone,
          active: dealer.active,
          commissionPercent: dealer.commissionPercent.toFixed(2),
          photoId: dealer.photoId,
          createdAt: dealer.createdAt.toISOString(),
          assignedProperties: dealer.allocations.length,
          soldProperties: dealer.bookings.filter((b) => b.status === 'CONFIRMED').length,
          totalSalesValue: salesTotal.toFixed(2),
          totalCommission: commissionTotal.toFixed(2),
          commissionPaid: settledCommission.toFixed(2),
          commissionPending: commissionTotal.minus(settledCommission).toFixed(2),
          allocations: dealer.allocations.map((a) => ({
            unitId: a.unitId,
            expiresAt: a.expiresAt.toISOString(),
            unitNumber: a.unit.number,
            unitType: a.unit.type,
            unitSize: `${a.unit.size} ${a.unit.measurementUnit}`,
            unitPrice: a.unit.price.toFixed(2),
            unitStatus: a.unit.status,
            phase: a.unit.phase,
            block: a.unit.block,
          })),
          bookings: dealer.bookings.map((b) => ({
            id: b.id,
            reference: b.reference,
            customerName: b.customer.name,
            customerPhone: b.customer.phone,
            unitNumber: b.unit.number,
            unitType: b.unit.type,
            total: b.total.toFixed(2),
            status: b.status,
            confirmedAt: b.confirmedAt?.toISOString() ?? null,
          })),
          commissions: dealer.commissions.map((c) => ({
            id: c.id,
            bookingReference: c.booking.reference,
            amount: c.amount.toFixed(2),
            status: c.status,
            settledAt: c.settledAt?.toISOString() ?? null,
            paymentReference: c.paymentReference,
          })),
        };
      }),
  );

  endpoint(
    app,
    'patch',
    root + '/dealers/:id',
    {
      permission: 'dealers.manage',
      summary: 'Update dealer information, commission rate or status',
      body: z
        .object({
          name: z.string().trim().min(2).max(200).optional(),
          phone: z.string().trim().min(6).max(30).optional(),
          commissionPercent: positiveMoney.optional(),
          active: z.boolean().optional(),
          photoId: uuid.nullable().optional(),
        })
        .strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        found(await tx.dealer.findFirst({ where: { id: id(req), projectId: ctx.projectId } }));
        if (b.photoId) await requireImage(tx, ctx, b.photoId, 'DEALER');
        const updated = await tx.dealer.update({
          where: { id: id(req) },
          data: b,
        });
        await audit(tx, ctx, 'dealer.updated', updated.id);
        return updated;
      }),
  );

  endpoint(
    app,
    'post',
    root + '/dealers/:id/allocations',
    {
      permission: 'dealers.manage',
      summary: 'Assign an available property to a dealer without marking it sold',
      body: z
        .object({
          unitId: uuid,
          expiresAt: z.iso.datetime().optional(),
        })
        .strict(),
      status: 201,
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const dealer = found(
          await tx.dealer.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        requireState(
          dealer.active,
          'DEALER_INACTIVE',
          'Cannot assign properties to an inactive dealer.',
          422,
        );

        const unit = found(
          await tx.unit.findFirst({ where: { id: b.unitId, projectId: ctx.projectId } }),
        );
        requireState(
          unit.status === 'AVAILABLE',
          'UNIT_NOT_AVAILABLE',
          'Only available properties can be assigned to a dealer.',
          422,
        );

        // Ensure not already allocated to this dealer
        const existing = await tx.dealerAllocation.findUnique({
          where: { dealerId_unitId: { dealerId: dealer.id, unitId: unit.id } },
        });
        requireState(
          !existing,
          'ALREADY_ALLOCATED',
          'This property is already assigned to this dealer.',
          409,
        );

        const expiresAt = b.expiresAt
          ? new Date(b.expiresAt)
          : new Date(Date.now() + 30 * 86400000); // 30 days default

        const allocation = await tx.dealerAllocation.create({
          data: {
            dealerId: dealer.id,
            unitId: unit.id,
            expiresAt,
          },
          include: {
            unit: { select: { number: true, type: true, price: true } },
          },
        });

        await audit(tx, ctx, 'dealer.property_allocated', dealer.id, {
          unitId: unit.id,
          unitNumber: unit.number,
        });

        return allocation;
      }),
  );

  endpoint(
    app,
    'delete',
    root + '/dealers/:id/allocations/:unitId',
    {
      permission: 'dealers.manage',
      summary: 'Unassign property allocation from dealer',
    },
    async (ctx, _b, _q, req) =>
      transaction(async (tx) => {
        const dealer = found(
          await tx.dealer.findFirst({ where: { id: id(req), projectId: ctx.projectId } }),
        );
        const unitId = uuid.parse(req.params.unitId);

        const allocation = found(
          await tx.dealerAllocation.findUnique({
            where: { dealerId_unitId: { dealerId: dealer.id, unitId } },
          }),
        );

        await tx.dealerAllocation.delete({
          where: { dealerId_unitId: { dealerId: dealer.id, unitId } },
        });

        await audit(tx, ctx, 'dealer.allocation_removed', dealer.id, { unitId });
        return { success: true };
      }),
  );

  endpoint(
    app,
    'post',
    root + '/dealers/commissions/:id/settle',
    {
      permission: 'commissions.approve',
      summary: 'Settle a pending dealer commission',
      body: z.object({ paymentReference: z.string().trim().min(3).max(200) }).strict(),
    },
    async (ctx, b, _q, req) =>
      transaction(async (tx) => {
        const commission = found(
          await tx.dealerCommission.findFirst({
            where: { id: id(req), dealer: { projectId: ctx.projectId } },
          }),
        );
        requireState(
          commission.status === 'PENDING',
          'COMMISSION_NOT_PENDING',
          'Only pending commissions can be settled.',
          422,
        );

        const updated = await tx.dealerCommission.update({
          where: { id: commission.id },
          data: {
            status: 'COMPLETED',
            settledAt: new Date(),
            paymentReference: b.paymentReference,
          },
        });

        await audit(tx, ctx, 'dealer.commission_settled', commission.id, {
          amount: commission.amount.toFixed(2),
          paymentReference: b.paymentReference,
        });

        return updated;
      }),
  );

  // Public computerized property file verification endpoint (no sensitive CNIC/phone revealed)
  endpoint(
    app,
    'get',
    '/verify/file/:reference',
    {
      public: true,
      summary: 'Public computerized property file verification without sensitive customer data',
    },
    async (_ctx, _b, _q, req) => {
      const ref = String(req.params.reference ?? '').trim();
      if (!ref) {
        throw new Error('Reference is required');
      }

      const booking = await db.booking.findFirst({
        where: { reference: { equals: ref, mode: 'insensitive' } },
        include: {
          unit: {
            select: {
              number: true,
              type: true,
              phase: true,
              block: true,
              tower: true,
              floor: true,
              size: true,
              measurementUnit: true,
              project: { select: { name: true, code: true, currency: true } },
            },
          },
          customer: {
            select: {
              name: true,
              identityLast4: true,
            },
          },
        },
      });

      if (!booking) {
        return {
          valid: false,
          reference: ref,
          message: 'No official property file found matching this registration reference.',
          verifiedAt: new Date().toISOString(),
        };
      }

      return {
        valid: true,
        reference: booking.reference,
        status: booking.status,
        projectName: booking.unit.project.name,
        projectCode: booking.unit.project.code,
        propertyNumber: booking.unit.number,
        propertyType: booking.unit.type,
        phase: booking.unit.phase,
        block: booking.unit.block,
        tower: booking.unit.tower,
        floor: booking.unit.floor,
        size: `${booking.unit.size} ${booking.unit.measurementUnit}`,
        total: booking.total.toFixed(2),
        currency: booking.unit.project.currency,
        customerName: booking.customer.name,
        customerIdentityLast4: booking.customer.identityLast4,
        confirmedAt: booking.confirmedAt?.toISOString() ?? null,
        verifiedAt: new Date().toISOString(),
      };
    },
  );
}
