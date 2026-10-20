import { DateTime } from 'luxon';

export type StatementColumn = {
  key: string;
  label: string;
  type?: 'money' | 'date' | 'status';
  width: number;
};
export type StatementSection = {
  title: string;
  description: string;
  columns: StatementColumn[];
  rows: Record<string, string | null>[];
};
export type AccountStatement = {
  project: { name: string; currency: string; timezone: string };
  customer: { id?: string; name: string; reference: string; email?: string | null; phone?: string | null };
  generatedAt: string;
  reference?: string;
  from?: string;
  to?: string;
  metrics: { label: string; amount: string; emphasis?: boolean }[];
  notes: string[];
  sections: StatementSection[];
};

export const paymentColumns: StatementColumn[] = [
  { key: 'date', label: 'Date', type: 'date', width: 65 },
  { key: 'reference', label: 'Receipt / booking', width: 125 },
  { key: 'method', label: 'Method', width: 64 },
  { key: 'status', label: 'Status', type: 'status', width: 82 },
  { key: 'amount', label: 'Amount', type: 'money', width: 110 },
];

export function statementStatus(value: string) {
  return (
    (
      {
        CLEARED: 'Verified',
        PENDING: 'Pending verification',
        DRAFT: 'Pending confirmation',
      } as Record<string, string>
    )[value] ??
    value
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace(/^./, (c) => c.toUpperCase())
  );
}

export function statementMoney(value: string) {
  const [whole, fraction = '00'] = value.split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}

export function statementValue(
  value: string | null | undefined,
  column: StatementColumn,
  statement: AccountStatement,
) {
  if (value == null || value === '') return '-';
  if (column.type === 'money') return statementMoney(value);
  if (column.type === 'date')
    return DateTime.fromISO(value, { zone: statement.project.timezone }).toFormat('dd MMM yyyy');
  if (column.type === 'status') return statementStatus(value);
  return value;
}
