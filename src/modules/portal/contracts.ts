import { z } from 'zod';
const text = z.string();
const nullable = text.nullable();
const project = z.object({ id: text, name: text, currency: text, timezone: text });
const position = z.object({
  bookings: z.number().int(),
  total: text,
  paid: text,
  outstanding: text,
  overdue: text,
  advanceCredit: text,
});
const booking = z.object({
  id: text,
  reference: text,
  status: text,
  total: text,
  downPayment: text,
  createdAt: text,
  confirmedAt: nullable,
  unit: z.object({
    number: text,
    type: text,
    phase: nullable,
    block: nullable,
    floor: nullable,
    size: text,
    measurementUnit: text,
    status: text,
    project,
  }),
});
const page = (item: z.ZodType) =>
  z.object({
    items: z.array(item),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  });
export function portalContract(path: string, method: string): z.ZodType | undefined {
  if (path === '/portal/activate') return z.object({ activated: z.boolean(), email: text });
  if (path.endsWith('/portal/invite'))
    return z.object({ status: text, email: text, expiresAt: text });
  if (path.endsWith('/portal'))
    return method === 'delete'
      ? z.object({ revoked: z.boolean() })
      : z.object({ status: text, email: nullable, expiresAt: nullable });
  if (path.endsWith('/portal-visibility')) return z.object({ updated: z.boolean() });
  if (!path.startsWith('/portal/')) return undefined;
  if (path.endsWith('/download')) return z.object({ url: text, expiresIn: z.number() });
  if (path.endsWith('/read')) return z.object({ read: z.boolean() });
  switch (path) {
    case '/portal/dashboard':
      return z.object({
        accounts: z.array(position.extend({ project })),
        asOf: text,
        upcoming: z.array(
          z.object({
            id: text,
            reference: text,
            bookingId: text,
            label: text,
            dueDate: text,
            outstanding: text,
            currency: text,
            projectName: text,
          }),
        ),
      });
    case '/portal/profile':
      return page(
        z.object({
          id: text,
          reference: text,
          name: text,
          phone: text,
          email: nullable,
          address: nullable,
          project,
        }),
      );
    case '/portal/bookings':
      return page(booking);
    case '/portal/bookings/:id':
      return booking.extend({ position });
    case '/portal/installments':
      return page(
        z.object({
          id: text,
          label: text,
          dueDate: text,
          amount: text,
          paid: text,
          outstanding: text,
          booking,
        }),
      );
    case '/portal/payments':
      return page(
        z.object({
          id: text,
          amount: text,
          method: text,
          paidAt: text,
          status: text,
          booking,
          receipt: z.object({ reference: text, createdAt: text, reversedAt: nullable }).nullable(),
        }),
      );
    case '/portal/documents':
      return page(
        z.object({
          id: text,
          name: text,
          mime: text,
          size: z.number(),
          createdAt: text,
          bookingId: nullable,
          project,
        }),
      );
    case '/portal/requests':
      return page(
        z.object({
          id: text,
          reference: text.optional(),
          status: text,
          booking,
          issuedAt: nullable.optional(),
          expiresAt: nullable.optional(),
          completedAt: nullable.optional(),
          paidAt: nullable.optional(),
          inspectionAt: nullable.optional(),
          handoverAt: nullable.optional(),
          amount: text.optional(),
          charges: text.optional(),
        }),
      );
    case '/portal/notifications':
      return page(
        z.object({ id: text, title: text, body: text, createdAt: text, readAt: nullable }),
      );
    default:
      throw new Error(`Missing portal response schema for ${method} ${path}`);
  }
}
