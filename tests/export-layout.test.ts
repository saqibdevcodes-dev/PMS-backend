import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { inflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { pdfBuffer } from '../src/jobs/report-pdf.js';
import { reportWorkbook } from '../src/jobs/report-xlsx.js';
import { excelNumber } from '../src/jobs/export-format.js';
import { statementPdf } from '../src/jobs/statement-pdf.js';
import type { AccountStatement } from '../src/modules/reports/statement-format.js';

const directory = '.runtime/export-review';
const branding = { name: 'Garden Homes Property Management' };
const metadata = { currency: 'PKR', timezone: 'Asia/Karachi', generatedAt: '2026-10-30T07:30:00Z' };
const rows = Array.from({ length: 38 }, (_, index) => ({
  reference: `RCP-${String(index + 1).padStart(4, '0')}`,
  customer: index % 3 ? 'Ayesha Ahmed' : 'Muhammad Abdullah with a longer customer name',
  paidAt: '2026-10-29T21:00:00Z',
  amount: index % 7 ? '1250000.25' : '-125000.50',
  status: index % 7 ? 'CLEARED' : 'REVERSED',
  description:
    index % 3
      ? 'Installment for property A-104.'
      : 'Installment and payment allocation details that should wrap cleanly within the report column without overlapping the amount or status.',
}));
const statement: AccountStatement = {
  project: { name: branding.name, currency: 'PKR', timezone: metadata.timezone },
  customer: {
    name: 'Ayesha Ahmed',
    reference: 'CUST-000042',
    email: 'customer@example.invalid',
    phone: '0300-1234567',
  },
  generatedAt: metadata.generatedAt,
  from: '2026-01-01',
  to: '2026-10-30',
  metrics: [
    { label: 'Contract value', amount: '4500000.00' },
    { label: 'Verified payments', amount: '1250000.25' },
    { label: 'Scheduled balance', amount: '3249999.75', emphasis: true },
  ],
  notes: [
    'Balances cover current confirmed bookings. Reversed payments do not reduce the balance.',
  ],
  sections: [
    {
      title: 'Payment history',
      description: 'Verified and reversed payments for the selected period.',
      columns: [
        { key: 'date', label: 'Payment date', type: 'date', width: 65 },
        { key: 'reference', label: 'Receipt / booking reference', width: 125 },
        { key: 'method', label: 'Payment method', width: 64 },
        { key: 'status', label: 'Verification status', type: 'status', width: 82 },
        { key: 'amount', label: 'Payment amount', type: 'money', width: 110 },
      ],
      rows: rows.map((row) => ({
        date: row.paidAt,
        reference: `${row.reference}\nBK-0042 / A-104`,
        method: 'Bank transfer',
        status: row.status,
        amount: row.amount,
      })),
    },
  ],
};

function pdfText(bytes: Buffer) {
  const raw = bytes.toString('latin1');
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
  return streams
    .map((stream) => {
      try {
        const content = inflateSync(Buffer.from(stream[1]!, 'latin1')).toString('latin1');
        return [...content.matchAll(/\[([^\]]+)\] TJ/g)]
          .map((match) =>
            [...match[1]!.matchAll(/<([a-f\d]+)>/gi)]
              .map((part) => Buffer.from(part[1]!, 'hex').toString('latin1'))
              .join(''),
          )
          .join(' ');
      } catch {
        return '';
      }
    })
    .join(' ');
}

describe('light export layouts', () => {
  it('keeps native Excel values, safe precision, filters, wrapping and printable headers after reopening', async () => {
    await mkdir(directory, { recursive: true });
    const workbook = reportWorkbook({
      title: 'Collections report',
      projectName: branding.name,
      ...metadata,
      rows,
      summary: { collected: '1250000.25', balanced: true },
    });
    const bytes = await workbook.xlsx.writeBuffer();
    await writeFile(`${directory}/collections.xlsx`, Buffer.from(bytes));
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(bytes);
    const sheet = reopened.worksheets[0]!;
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 7, showGridLines: false });
    expect(sheet.getCell('D8').value).toBe(-125000.5);
    expect(sheet.getCell('D8').numFmt).toContain('#,##0.00');
    expect(sheet.getCell('D8').alignment.horizontal).toBe('right');
    expect(sheet.getCell('C8').value).toEqual(new Date('2026-10-30T00:00:00Z'));
    expect(sheet.getCell('F8').alignment.wrapText).toBe(true);
    expect(sheet.getRow(8).height).toBeGreaterThan(26);
    expect(sheet.getCell('A8').fill).toMatchObject({ fgColor: { argb: 'FFFFFF' } });
    expect(sheet.pageSetup).toMatchObject({
      orientation: 'landscape',
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '7:7',
    });
    expect(sheet.autoFilter).toBeTruthy();
    expect(excelNumber('9007199254740993.25')).toBe('9007199254740993.25');
    expect(excelNumber('12.34')).toBe(12.34);
  });

  it('exports the statement summary and its labeled sections with numeric totals', async () => {
    const workbook = reportWorkbook({
      title: 'Customer statement',
      projectName: branding.name,
      ...metadata,
      rows: [],
      statement,
    });
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Account statement',
      'Payment history',
    ]);
    expect(workbook.worksheets[0]!.getCell('B13').value).toBe(4500000);
    expect(workbook.worksheets[1]!.getCell('D9').value).toBe('Reversed');
    expect(workbook.worksheets[1]!.getCell('E9').value).toBe(-125000.5);
    await writeFile(`${directory}/statement.xlsx`, Buffer.from(await workbook.xlsx.writeBuffer()));
  });

  it('paginates report tables, preserves every record and repeats headings', async () => {
    const bytes = await pdfBuffer('Collections report', rows, branding, metadata);
    await writeFile(`${directory}/collections.pdf`, bytes);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    const pageCount = (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
    expect(pageCount).toBeLessThan(15);
    const text = pdfText(bytes);
    expect(text).toContain('RCP-0001');
    expect(text).toContain('RCP-0038');
    expect(text.match(/Collections report/g)!.length).toBe(pageCount);
    expect(text).toContain('PKR');
  });

  it('keeps wide report fields in labeled column groups without dropping data', async () => {
    const wide = rows.slice(0, 3).map((row) => ({
      ...row,
      buyPrice: '1000000',
      taxes: '10000',
      legalFees: '2000',
      brokerage: '5000',
      totalCost: '1017000',
      salePrice: '1500000',
      netProfit: '483000',
    }));
    const bytes = await pdfBuffer('Property profitability report', wide, branding, metadata);
    await writeFile(`${directory}/wide-report.pdf`, bytes);
    const text = pdfText(bytes);
    expect(text).toContain('Column group 1 of 2');
    expect(text).toContain('Column group 2 of 2');
    expect(text).toContain('483,000.00');
  });

  it('keeps customer statement headings, amounts and wording across page breaks', async () => {
    const bytes = await statementPdf(statement, branding);
    await writeFile(`${directory}/statement.pdf`, bytes);
    const text = pdfText(bytes);
    expect(text).toContain('RCP-0038');
    expect(text).toContain('45 lac PKR');
    expect(text).toContain('Payment history (continued)');
  });
});
