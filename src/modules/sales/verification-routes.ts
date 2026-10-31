import type { Express } from 'express';
import { z } from 'zod';
import { db } from '../../database/client.js';
import { endpoint } from '../../common/http.js';

const identifier = z.string().trim().min(8).max(80);
const uuid = z.uuid();
const notFound = () => ({
  valid: false,
  message: 'No official record matches this identifier.',
  verifiedAt: new Date().toISOString(),
});

// An ambiguous printed code must never select someone else's record.
async function publicId(kind: 'User' | 'Customer', raw: string) {
  if (uuid.safeParse(raw).success) return raw;
  const clean = raw.replace(/^(EMP|USR|MEM|CUST)-/i, '').toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(clean)) return null;
  const rows =
    kind === 'User'
      ? await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "User" WHERE "accountType" = 'STAFF' AND left(replace(id::text, '-', ''), 8) = ${clean} LIMIT 2`
      : await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Customer" WHERE left(replace(id::text, '-', ''), 8) = ${clean} LIMIT 2`;
  return rows.length === 1 ? rows[0]!.id : null;
}

export function verificationRoutes(app: Express) {
  endpoint(
    app,
    'get',
    '/verify/file/:reference',
    {
      public: true,
      summary: 'Verify a property file without disclosing customer or financial data',
    },
    async (_ctx, _body, _query, req) => {
      const reference = identifier.parse(req.params.reference);
      const booking = await db.booking.findFirst({
        where: { reference: { equals: reference, mode: 'insensitive' } },
        select: {
          reference: true,
          status: true,
          confirmedAt: true,
          unit: {
            select: { number: true, type: true, project: { select: { name: true, code: true } } },
          },
        },
      });
      if (!booking) return notFound();
      return {
        valid: true,
        reference: booking.reference,
        status: booking.status,
        projectName: booking.unit.project.name,
        projectCode: booking.unit.project.code,
        propertyNumber: booking.unit.number,
        propertyType: booking.unit.type,
        confirmedAt: booking.confirmedAt?.toISOString() ?? null,
        verifiedAt: new Date().toISOString(),
      };
    },
  );

  endpoint(
    app,
    'get',
    '/verify/employee/:identifier',
    {
      public: true,
      summary: 'Verify staff registration using a UUID or complete printed code',
    },
    async (_ctx, _body, _query, req) => {
      const id = await publicId('User', identifier.parse(req.params.identifier));
      if (!id) return notFound();
      const user = await db.user.findFirst({
        where: { id, accountType: 'STAFF' },
        select: { id: true, name: true, active: true },
      });
      if (!user) return notFound();
      return {
        valid: true,
        employeeCode: `USR-${user.id.slice(0, 8).toUpperCase()}`,
        name: user.name,
        active: user.active,
        status: user.active ? 'ACTIVE_STAFF' : 'INACTIVE',
        message: user.active
          ? 'Active staff registration verified.'
          : 'This staff registration is inactive.',
        verifiedAt: new Date().toISOString(),
      };
    },
  );

  endpoint(
    app,
    'get',
    '/verify/customer/:identifier',
    {
      public: true,
      summary: 'Verify customer registration without exposing identity or financial records',
    },
    async (_ctx, _body, _query, req) => {
      const raw = identifier.parse(req.params.identifier);
      const exact = await db.customer.findFirst({
        where: { reference: { equals: raw, mode: 'insensitive' } },
        select: { id: true },
      });
      const id = exact?.id ?? (await publicId('Customer', raw));
      if (!id) return notFound();
      const customer = await db.customer.findUnique({
        where: { id },
        select: {
          id: true,
          project: { select: { name: true, code: true } },
          owners: {
            where: { validTo: null, booking: { status: 'CONFIRMED' } },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!customer) return notFound();
      return {
        valid: true,
        customerCode: `MEM-${customer.id.slice(0, 8).toUpperCase()}`,
        projectName: customer.project.name,
        projectCode: customer.project.code,
        status: customer.owners.length ? 'CURRENT_OWNER' : 'REGISTERED_CUSTOMER',
        message: customer.owners.length
          ? 'Current ownership registration verified.'
          : 'Customer registration verified. No current confirmed ownership.',
        verifiedAt: new Date().toISOString(),
      };
    },
  );
}
