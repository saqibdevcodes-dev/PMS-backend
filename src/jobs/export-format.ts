import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import type { ReportRow } from '../modules/reports/service.js';

export const exportPalette = {
  paper: 'FFFFFF',
  ink: '203249',
  muted: '536477',
  blue: '355E85',
  header: 'EAF0F6',
  stripe: 'F6F8FB',
  border: 'DFE6EE',
};

const monetaryKeys =
  /^(amount|price|basePrice|buyPrice|salePrice|sellingPrice|listedPrice|listPrice|askingPrice|taxes|legalFees|brokerage|otherCosts|charges|discount|deduction|refundable|refundAmount|debit|credit|balance|paid|outstanding|overdue|collected|unallocated|advanceCredit|downPayment|commission|promiseAmount|netIncome|netProfit|revenue|expense|assets|liabilities|equity|netSales|verifiedCollections|total|totalCost|totalBuyPrice|totalExpenses|totalInvestedCost|totalSalesRevenue|totalRealizedProfit|totalNetProfit)$/i;

export type ExportColumn = {
  key: string;
  label: string;
  type: 'text' | 'money' | 'number' | 'date' | 'percent';
  width: number;
};

export function exportLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\bid\b/gi, 'ID')
    .replace(/^./, (s) => s.toUpperCase());
}

export function exportColumns(rows: ReportRow[]): ExportColumn[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].map((key) => {
    const values = rows.map((row) => row[key]).filter((value) => value != null && value !== '');
    const type = monetaryKeys.test(key)
      ? 'money'
      : /percent|marginPercent$/i.test(key)
        ? 'percent'
        : /At$|Date$|^date$/i.test(key)
          ? 'date'
          : values.length && values.every((value) => typeof value === 'number')
            ? 'number'
            : 'text';
    const width =
      type === 'money'
        ? 23
        : type === 'date'
          ? 18
          : type === 'number' || type === 'percent'
            ? 16
            : /description|title|name|reference/i.test(key)
              ? 32
              : /Id$|^id$/.test(key)
                ? 38
                : 22;
    return { key, label: exportLabel(key), type, width };
  });
}

export function exportMoney(value: unknown) {
  try {
    const amount = new Prisma.Decimal(String(value));
    if (!amount.isFinite()) return '-';
    const [whole, cents] = amount.toFixed(2).split('.');
    return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
  } catch {
    return '-';
  }
}

export function exportAmountWords(value: unknown, currency: string) {
  try {
    const amount = new Prisma.Decimal(String(value));
    if (!amount.isFinite()) return '';
    const rounded = amount.abs().toDecimalPlaces(2);
    let whole = BigInt(rounded.floor().toFixed(0));
    const parts: string[] = [];
    for (const [divisor, label] of [
      [10000000n, 'crore'],
      [100000n, 'lac'],
      [1000n, 'thousand'],
      [100n, 'hundred'],
    ] as const) {
      const count = whole / divisor;
      if (count) parts.push(`${count.toLocaleString('en-US')} ${label}`);
      whole %= divisor;
    }
    if (whole) parts.push(String(whole));
    if (!parts.length) parts.push('0');
    const fraction = rounded.minus(rounded.floor()).mul(100);
    if (fraction.gt(0)) parts.push(`${fraction.toFixed(0)}/100`);
    return `${amount.isNegative() && !rounded.isZero() ? '-' : ''}${parts.join(' ')} ${currency}`.trim();
  } catch {
    return '';
  }
}

export function exportValue(value: unknown, column: ExportColumn, timezone = 'Asia/Karachi') {
  if (value == null || value === '') return '-';
  if (column.type === 'money') return exportMoney(value);
  if (column.type === 'percent') return `${String(value).replace(/%$/, '')}%`;
  if (column.type === 'date') {
    const date = DateTime.fromISO(String(value), { zone: timezone });
    return date.isValid ? date.toFormat('dd MMM yyyy') : String(value);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (column.key === 'status' || column.key === 'dealStatus')
    return exportLabel(String(value).toLowerCase());
  return String(value);
}

/** Excel has 15 significant digits; retain exact decimal text outside that range. */
export function excelNumber(value: unknown): number | string {
  try {
    const amount = new Prisma.Decimal(String(value));
    if (!amount.isFinite()) return String(value);
    const numeric = amount.toNumber();
    return amount.sd() <= 15 &&
      amount.abs().lte(Number.MAX_SAFE_INTEGER) &&
      new Prisma.Decimal(numeric).eq(amount)
      ? numeric
      : amount.toFixed(2);
  } catch {
    return String(value);
  }
}
