import { type Prisma } from '@prisma/client';
import { sum } from '../../common/money.js';

// Operational realization means a confirmed contract whose full value has
// cleared. Revenue recognition in the general ledger remains a separate policy.
export function dealPosition(
  cost: Prisma.Decimal,
  booking?: {
    status: string;
    total: Prisma.Decimal;
    payments: { amount: Prisma.Decimal }[];
  },
) {
  const collected = sum(booking?.payments.map((p) => p.amount) ?? []);
  const salePrice = booking?.status === 'CONFIRMED' ? booking.total : null;
  const projectedProfit = booking ? booking.total.minus(cost) : null;
  const netProfit = salePrice && collected.gte(salePrice) ? salePrice.minus(cost) : null;
  return { collected, salePrice, projectedProfit, netProfit };
}

export function dealStage(purchaseStatus: string, unitStatus?: string, bookingStatus?: string) {
  if (bookingStatus) return bookingStatus === 'CONFIRMED' ? 'SOLD' : 'BOOKED';
  if (purchaseStatus !== 'POSTED') return 'DRAFT';
  return unitStatus === 'AVAILABLE' ? 'AVAILABLE' : 'UNLISTED';
}
