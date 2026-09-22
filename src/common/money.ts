import { Prisma } from '@prisma/client';
import { z } from 'zod';
export const money = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/,
    'Use a non-negative decimal string with up to 2 decimal places',
  );
export const positiveMoney = money.refine(
  (v) => new Prisma.Decimal(v).gt(0),
  'Amount must be positive',
);
export const decimal = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
export const sum = (values: Prisma.Decimal.Value[]) =>
  values.reduce<Prisma.Decimal>((a, b) => a.plus(b), decimal(0));
export function splitAmount(total: Prisma.Decimal.Value, percentages: string[]) {
  const value = decimal(total);
  let assigned = decimal(0);
  return percentages.map((p, i) => {
    const amount =
      i === percentages.length - 1
        ? value.minus(assigned)
        : value.mul(p).div(100).toDecimalPlaces(2);
    assigned = assigned.plus(amount);
    return amount;
  });
}
