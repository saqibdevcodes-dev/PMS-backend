import { z } from 'zod';
import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';
import { money, positiveMoney, decimal } from '../../common/money.js';
import { requireState } from '../../common/errors.js';

export const paymentTerms = z
  .object({
    paymentType: z.enum(['FULL_PAYMENT', 'INSTALLMENTS']),
    downPayment: money.optional(),
    installmentCount: z.number().int().min(1).max(360).optional(),
    intervalMonths: z.number().int().min(1).max(12).optional(),
    firstInstallmentDate: z.iso.date().optional(),
  })
  .strict();
export const bookingInput = paymentTerms.extend({
  customerId: z.uuid(),
  unitId: z.uuid(),
  dealerId: z.uuid().optional(),
  sellingPrice: positiveMoney.optional(),
  discount: money.default('0'),
  confirm: z.boolean().default(false),
  owners: z
    .array(z.object({ customerId: z.uuid(), share: positiveMoney }).strict())
    .min(1)
    .max(20)
    .optional(),
});
export type PaymentTerms = z.infer<typeof paymentTerms>;

// Money is always calculated with decimals. The final row absorbs cent rounding.
export function equalInstallments(
  amount: Prisma.Decimal,
  count: number,
  interval: number,
  firstDate: string,
) {
  requireState(
    Number.isInteger(count) &&
      count >= 1 &&
      count <= 360 &&
      Number.isInteger(interval) &&
      interval >= 1 &&
      interval <= 12,
    'INVALID_SCHEDULE',
    'Choose 1–360 installments and a frequency of 1–12 months.',
    422,
  );
  const date = DateTime.fromISO(firstDate, { zone: 'UTC' });
  requireState(date.isValid, 'INVALID_DATE', 'Choose the first installment date.', 422);
  const each = amount.div(count).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  requireState(
    each.gte('0.01'),
    'INSTALLMENT_TOO_SMALL',
    'Reduce the number of installments: each payment must be at least 0.01.',
    422,
  );
  return Array.from({ length: count }, (_, index) => ({
    label: `Installment ${index + 1}`,
    dueDate: date.plus({ months: index * interval }).toISODate()!,
    amount: (index === count - 1 ? amount.minus(each.mul(count - 1)) : each).toFixed(2),
  }));
}

export function calculatePaymentPlan(
  total: Prisma.Decimal,
  terms: PaymentTerms,
  minimumPercent: Prisma.Decimal,
  today: string,
) {
  requireState(total.gt(0), 'INVALID_PRICE', 'The amount payable must be greater than zero.', 422);
  if (terms.paymentType === 'FULL_PAYMENT')
    return {
      downPayment: decimal(0),
      schedule: [{ label: 'Full payment', amount: total.toFixed(2), dueDate: today }],
    };
  requireState(
    terms.downPayment !== undefined &&
      terms.installmentCount &&
      terms.intervalMonths &&
      terms.firstInstallmentDate,
    'PAYMENT_PLAN_REQUIRED',
    'Enter the down payment, installment count, frequency and first due date.',
    422,
  );
  const downPayment = decimal(terms.downPayment);
  const minimum = total.mul(minimumPercent).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_UP);
  requireState(
    downPayment.gte(minimum) && downPayment.lt(total),
    'INVALID_DOWN_PAYMENT',
    `Down payment must be at least ${minimum.toFixed(2)} and less than the total. Choose Full Payment to pay everything at once.`,
    422,
  );
  requireState(
    terms.firstInstallmentDate >= today,
    'INVALID_DATE',
    'The first installment date cannot be in the past.',
    422,
  );
  const installments = equalInstallments(
    total.minus(downPayment),
    terms.installmentCount,
    terms.intervalMonths,
    terms.firstInstallmentDate,
  );
  return {
    downPayment,
    schedule: [
      ...(downPayment.gt(0)
        ? [{ label: 'Down payment', amount: downPayment.toFixed(2), dueDate: today }]
        : []),
      ...installments,
    ],
  };
}
