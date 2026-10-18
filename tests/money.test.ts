import { describe, it, expect } from 'vitest';
import { decimal, splitAmount, sum, money } from '../src/common/money.js';
import { calculatePaymentPlan, equalInstallments } from '../src/modules/sales/payment-plan.js';
describe('exact financial arithmetic', () => {
  it('preserves rounding remainder without losing a cent', () => {
    const result = splitAmount('100.01', ['33.33', '33.33', '33.34']);
    expect(sum(result).toFixed(2)).toBe('100.01');
    expect(result.map((r) => r.toFixed(2))).toEqual(['33.33', '33.33', '33.35']);
  });
  it('never accepts numeric floating point money or excess scale', () => {
    expect(money.safeParse(0.1).success).toBe(false);
    expect(money.safeParse('1.001').success).toBe(false);
    expect(money.safeParse('-1').success).toBe(false);
    expect(decimal('0.1').plus('0.2').toFixed(2)).toBe('0.30');
  });
  it('ignores minimum down payment for full payment and keeps the total exact', () => {
    const plan = calculatePaymentPlan(
      decimal('100.01'),
      { paymentType: 'FULL_PAYMENT' },
      decimal('90'),
      '2026-10-15',
    );
    expect(plan.downPayment.toFixed(2)).toBe('0.00');
    expect(plan.schedule).toEqual([
      { label: 'Full payment', amount: '100.01', dueDate: '2026-10-15' },
    ]);
  });
  it('keeps a month-end anchor through leap years and rejects sub-cent installments', () => {
    const plan = equalInstallments(decimal('100'), 3, 1, '2028-01-31');
    expect(plan.map((r) => r.dueDate)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    expect(plan.map((r) => r.amount)).toEqual(['33.33', '33.33', '33.34']);
    expect(() => equalInstallments(decimal('0.02'), 3, 1, '2028-01-31')).toThrow();
  });
});
