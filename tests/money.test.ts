import { describe, it, expect } from 'vitest';
import { decimal, splitAmount, sum, money } from '../src/common/money.js';
import { scheduleSchema } from '../src/modules/sales/service.js';
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
  it('rejects schedules that do not sum to 100 percent', () => {
    expect(scheduleSchema.safeParse([{ label: 'All', percent: '99' }]).success).toBe(false);
  });
});
