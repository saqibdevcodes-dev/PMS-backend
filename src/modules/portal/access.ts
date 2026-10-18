import type { Prisma } from '@prisma/client';

// A primary owner retains cancelled-booking history; prior owners lose access after transfer.
export function ownedBookings(userId: string): Prisma.BookingWhereInput {
  return {
    OR: [
      { customer: { portalUserId: userId } },
      { owners: { some: { validTo: null, customer: { portalUserId: userId } } } },
    ],
  };
}
export function visibleDocuments(userId: string): Prisma.DocumentWhereInput {
  return {
    portalVisible: true,
    OR: [
      // Customer-specific documents must never become visible to a different/new booking owner.
      { customer: { portalUserId: userId } },
      { customerId: null, booking: ownedBookings(userId) },
      {
        allProjectCustomers: true,
        customerId: null,
        bookingId: null,
        project: { customers: { some: { portalUserId: userId } } },
      },
    ],
  };
}
