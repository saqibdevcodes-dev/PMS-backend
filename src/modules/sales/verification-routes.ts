import type { Express } from 'express';
import { db } from '../../database/client.js';
import { endpoint } from '../../common/http.js';
import { financialPosition, projectDay } from '../portal/service.js';

export function verificationRoutes(app: Express) {
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

  // Public employee verification endpoint (verifies active staff credentials & authorization)
  endpoint(
    app,
    'get',
    '/verify/employee/:id',
    {
      public: true,
      summary: 'Public employee verification by employee ID or employee code',
    },
    async (_ctx, _b, _q, req) => {
      const raw = String(req.params.id ?? '').trim();
      if (!raw) {
        return {
          valid: false,
          message: 'Employee ID or code is required',
          verifiedAt: new Date().toISOString(),
        };
      }

      const isCode = raw.toUpperCase().startsWith('EMP-');
      const clean = isCode ? raw.slice(4).trim() : raw;

      let user =
        clean.length === 36
          ? await db.user.findFirst({
              where: { id: clean, accountType: 'STAFF' },
              include: {
                roles: { include: { role: true } },
                projects: { include: { project: { select: { name: true, code: true } } } },
              },
            })
          : null;

      if (!user) {
        const staff = await db.user.findMany({
          where: { accountType: 'STAFF' },
          include: {
            roles: { include: { role: true } },
            projects: { include: { project: { select: { name: true, code: true } } } },
          },
        });
        user =
          staff.find(
            (u) =>
              u.id.replace(/-/g, '').toLowerCase().startsWith(clean.toLowerCase()) ||
              u.id.toLowerCase().startsWith(clean.toLowerCase()),
          ) ?? null;
      }

      if (!user) {
        return {
          valid: false,
          message: 'No official employee record found matching this identifier.',
          verifiedAt: new Date().toISOString(),
        };
      }

      return {
        valid: true,
        employeeId: user.id,
        employeeCode: `EMP-${user.id.slice(0, 8).toUpperCase()}`,
        name: user.name,
        active: user.active,
        status: user.active ? 'ACTIVE_STAFF' : 'INACTIVE',
        photoId: user.photoId,
        roles: user.roles.map((r) => r.role.name),
        projects: user.projects.map((p) => p.project.name),
        joinedAt: user.createdAt.toISOString(),
        verifiedAt: new Date().toISOString(),
        message: user.active
          ? 'Officially authorized and active staff member.'
          : 'Former or currently inactive staff member.',
      };
    },
  );

  // Public customer / allottee verification endpoint
  endpoint(
    app,
    'get',
    '/verify/customer/:id',
    {
      public: true,
      summary: 'Public customer verification by customer ID or customer code',
    },
    async (_ctx, _b, _q, req) => {
      const raw = String(req.params.id ?? '').trim();
      if (!raw) {
        return {
          valid: false,
          message: 'Customer ID or code is required',
          verifiedAt: new Date().toISOString(),
        };
      }

      const isCode = raw.toUpperCase().startsWith('CUST-') || raw.toUpperCase().startsWith('MEM-');
      const clean = isCode ? raw.slice(raw.indexOf('-') + 1).trim() : raw;

      let customer =
        clean.length === 36
          ? await db.customer.findFirst({
              where: { id: clean },
              include: {
                project: {
                  select: { id: true, name: true, code: true, currency: true, timezone: true },
                },
                owners: {
                  where: { validTo: null },
                  include: {
                    booking: { select: { reference: true, status: true } },
                  },
                },
              },
            })
          : null;

      if (!customer) {
        const customers = await db.customer.findMany({
          take: 500,
          orderBy: { createdAt: 'desc' },
          include: {
            project: {
              select: { id: true, name: true, code: true, currency: true, timezone: true },
            },
            owners: {
              where: { validTo: null },
              include: {
                booking: { select: { reference: true, status: true } },
              },
            },
          },
        });
        customer =
          customers.find(
            (c) =>
              c.id.replace(/-/g, '').toLowerCase().startsWith(clean.toLowerCase()) ||
              c.id.toLowerCase().startsWith(clean.toLowerCase()) ||
              c.reference.toLowerCase() === clean.toLowerCase(),
          ) ?? null;
      }

      if (!customer) {
        return {
          valid: false,
          message: 'No official customer record found matching this identifier.',
          verifiedAt: new Date().toISOString(),
        };
      }

      const unit = { projectId: customer.project.id };
      const today = projectDay(customer.project.timezone);
      const position = await financialPosition(
        {
          unit,
          status: 'CONFIRMED',
          owners: { some: { customerId: customer.id, validTo: null } },
        },
        today,
        db,
      );

      const bookings = await db.booking.findMany({
        where: { unit, owners: { some: { customerId: customer.id } } },
        select: {
          id: true,
          reference: true,
          status: true,
          total: true,
          createdAt: true,
          unit: {
            select: {
              number: true,
              type: true,
              size: true,
              phase: true,
              block: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      const payments = await db.payment.findMany({
        where: {
          payerId: customer.id,
          status: { in: ['CLEARED', 'REVERSED'] },
        },
        select: {
          id: true,
          amount: true,
          status: true,
          method: true,
          paidAt: true,
          receipt: { select: { reference: true } },
          booking: { select: { reference: true, unit: { select: { number: true } } } },
        },
        orderBy: { paidAt: 'desc' },
        take: 15,
      });

      return {
        valid: true,
        customerId: customer.id,
        customerCode: `CUST-${customer.id.slice(0, 8).toUpperCase()}`,
        name: customer.name,
        identityLast4: customer.identityLast4,
        photoId: customer.photoId,
        projectName: customer.project.name,
        projectCode: customer.project.code,
        currency: customer.project.currency,
        financial: {
          total: position.total,
          paid: position.paid,
          outstanding: position.outstanding,
          overdue: position.overdue,
          advanceCredit: position.advanceCredit,
          bookingsCount: position.bookings,
        },
        bookings: bookings.map((b) => ({
          reference: b.reference,
          status: b.status,
          total: b.total.toFixed(2),
          unitNumber: b.unit.number,
          unitType: b.unit.type,
          size: b.unit.size,
          location: [b.unit.phase, b.unit.block].filter(Boolean).join(' · '),
        })),
        payments: payments.map((p) => ({
          receiptRef: p.receipt?.reference ?? 'Receipt recorded',
          bookingRef: p.booking?.reference,
          unitNumber: p.booking?.unit?.number,
          paidAt: p.paidAt.toISOString(),
          amount: p.amount.toFixed(2),
          method: p.method,
          status: p.status,
        })),
        activeBookings: customer.owners.map((o) => o.booking.reference),
        joinedAt: customer.createdAt.toISOString(),
        verifiedAt: new Date().toISOString(),
        message: 'Officially registered customer/allottee in real estate project records.',
      };
    },
  );
}
