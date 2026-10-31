import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import type { AccountStatement } from '../modules/reports/statement-format.js';
import type { ReportRow } from '../modules/reports/service.js';
import {
  excelNumber,
  exportColumns,
  exportLabel,
  exportPalette as color,
  exportValue,
  type ExportColumn,
} from './export-format.js';

type WorkbookInput = {
  title: string;
  projectName: string;
  currency: string;
  timezone?: string;
  generatedAt?: string;
  rows: ReportRow[];
  summary?: Record<string, unknown>;
  filters?: Record<string, unknown>;
  statement?: AccountStatement;
};

const border: Partial<ExcelJS.Borders> = {
  bottom: { style: 'thin', color: { argb: color.border } },
};
const fill = (argb: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb },
});

export function reportWorkbook(input: WorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  const generated = new Date(input.generatedAt ?? new Date());
  const timezone = input.timezone ?? 'Asia/Karachi';
  workbook.creator = input.projectName;
  workbook.title = input.title;
  workbook.subject = `${input.projectName} - ${input.currency}`;
  workbook.created = generated;
  workbook.modified = generated;

  function sheet(name: string, columns: ExportColumn[]) {
    const safeName = name.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || 'Report';
    const worksheet = workbook.addWorksheet(safeName, {
      properties: { defaultRowHeight: 24, tabColor: { argb: color.blue } },
      views: [{ state: 'normal', showGridLines: false }],
      pageSetup: {
        paperSize: 9,
        orientation: columns.length > 5 ? 'landscape' : 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      },
    });
    worksheet.headerFooter.oddFooter = `&L${input.projectName.replaceAll('&', '&&')}&RPage &P of &N`;
    worksheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));
    const count = Math.max(columns.length, 3);
    if (worksheet.columnCount < count) worksheet.getColumn(count).width = 24;
    const titleRow = worksheet.getRow(2);
    titleRow.getCell(1).value = name;
    titleRow.getCell(1).font = { name: 'Arial', size: 16, bold: true, color: { argb: color.ink } };
    titleRow.height = 30;
    for (let i = 1; i <= count; i++) {
      titleRow.getCell(i).alignment = { horizontal: 'centerContinuous', vertical: 'middle' };
      titleRow.getCell(i).border = border;
    }
    worksheet.getCell('A3').value = input.projectName;
    worksheet.getCell('A4').value = `Currency: ${input.currency}`;
    worksheet.getCell('A5').value =
      `Generated: ${DateTime.fromJSDate(generated, { zone: timezone }).toFormat('dd MMM yyyy, HH:mm')}`;
    for (const number of [3, 4, 5]) {
      const row = worksheet.getRow(number);
      row.height = 22;
      for (let i = 1; i <= count; i++) {
        row.getCell(i).font = {
          name: 'Arial',
          size: number === 3 ? 11 : 10,
          color: { argb: number === 3 ? color.ink : color.muted },
        };
        row.getCell(i).alignment = { horizontal: 'centerContinuous', vertical: 'middle' };
      }
    }
    return worksheet;
  }

  function writeTable(
    worksheet: ExcelJS.Worksheet,
    columns: ExportColumn[],
    rows: ReportRow[],
    header: number,
  ) {
    const headerRow = worksheet.getRow(header);
    headerRow.height = 34;
    columns.forEach((column, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = column.label;
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: color.ink } };
      cell.fill = fill(color.header);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = border;
    });
    rows.forEach((record, index) => {
      const row = worksheet.getRow(header + index + 1);
      let lines = 1;
      columns.forEach((column, columnIndex) => {
        const raw = record[column.key];
        const cell = row.getCell(columnIndex + 1);
        const numeric = ['money', 'number', 'percent'].includes(column.type);
        if (raw == null || raw === '') cell.value = null;
        else if (column.type === 'money' || column.type === 'number') cell.value = excelNumber(raw);
        else if (column.type === 'percent') {
          const value = Number(String(raw).replace(/%$/, ''));
          cell.value = Number.isFinite(value) ? value / 100 : String(raw);
        } else if (column.type === 'date') {
          const date = DateTime.fromISO(String(raw), { zone: timezone });
          cell.value = date.isValid
            ? new Date(Date.UTC(date.year, date.month - 1, date.day))
            : String(raw);
        } else cell.value = exportValue(raw, column, timezone);
        cell.font = { name: 'Arial', size: 10, color: { argb: color.ink } };
        cell.fill = fill(index % 2 ? color.stripe : color.paper);
        cell.border = border;
        cell.alignment = {
          horizontal: numeric ? 'right' : 'left',
          indent: 1,
          vertical: 'top',
          wrapText: true,
        };
        if (column.type === 'money') cell.numFmt = '#,##0.00;[Red](#,##0.00);0.00';
        else if (column.type === 'number') cell.numFmt = '#,##0.##';
        else if (column.type === 'percent') cell.numFmt = '0.0%;[Red](0.0%);0.0%';
        else if (column.type === 'date') cell.numFmt = 'dd mmm yyyy';
        const displayed = exportValue(raw, column, timezone);
        lines = Math.max(
          lines,
          ...displayed
            .split('\n')
            .map((line) => Math.ceil(line.length / Math.max(8, column.width - 3))),
        );
      });
      row.height = Math.min(409, Math.max(26, lines * 14 + 12));
    });
    if (!rows.length) {
      const empty = worksheet.getRow(header + 1);
      empty.getCell(1).value = 'No entries for the selected period.';
      empty.getCell(1).font = {
        name: 'Arial',
        size: 10,
        italic: true,
        color: { argb: color.muted },
      };
      empty.height = 28;
    }
    worksheet.views = [
      { state: 'frozen', xSplit: columns.length > 5 ? 1 : 0, ySplit: header, showGridLines: false },
    ];
    if (columns.length && rows.length)
      worksheet.autoFilter = {
        from: { row: header, column: 1 },
        to: { row: header + rows.length, column: columns.length },
      };
    worksheet.pageSetup.printTitlesRow = `${header}:${header}`;
    worksheet.pageSetup.printArea = `A1:${worksheet.getColumn(Math.max(columns.length, 3)).letter}${header + Math.max(rows.length, 1)}`;
  }

  if (input.statement) {
    const statement = input.statement;
    const overviewColumns: ExportColumn[] = [
      { key: 'label', label: 'Account summary', type: 'text', width: 40 },
      { key: 'amount', label: `Amount (${input.currency})`, type: 'money', width: 26 },
      { key: 'words', label: 'Notes', type: 'text', width: 44 },
    ];
    const overview = sheet('Account statement', overviewColumns);
    overview.getCell('A7').value = statement.customer.name;
    overview.getCell('A8').value = statement.customer.reference;
    overview.getCell('A9').value = [statement.customer.email, statement.customer.phone]
      .filter(Boolean)
      .join(' / ');
    overview.getCell('A10').value =
      `Payment period: ${statement.from ?? 'Beginning'} to ${statement.to ?? 'Present'}`;
    for (const number of [7, 8, 9, 10]) {
      const row = overview.getRow(number);
      row.height = 24;
      for (let i = 1; i <= 3; i++) {
        row.getCell(i).font = {
          name: 'Arial',
          size: 10,
          color: { argb: color.ink },
          bold: number === 7,
        };
        row.getCell(i).alignment = { horizontal: 'centerContinuous', vertical: 'middle' };
      }
    }
    writeTable(
      overview,
      overviewColumns.slice(0, 2),
      statement.metrics.map((metric) => ({ label: metric.label, amount: metric.amount })),
      12,
    );
    let rowNumber = 14 + statement.metrics.length;
    for (const note of statement.notes) {
      overview.mergeCells(rowNumber, 1, rowNumber, 3);
      const cell = overview.getCell(rowNumber, 1);
      cell.value = note;
      cell.font = { name: 'Arial', size: 10, color: { argb: color.muted } };
      cell.alignment = { vertical: 'top', wrapText: true };
      overview.getRow(rowNumber).height = Math.max(30, Math.ceil(note.length / 100) * 14 + 12);
      rowNumber++;
    }
    overview.pageSetup.printArea = `A1:C${rowNumber}`;
    overview.views = [{ state: 'normal', showGridLines: false }];
    overview.autoFilter = undefined;
    for (const section of statement.sections) {
      const columns: ExportColumn[] = section.columns.map((column) => ({
        key: column.key,
        label: column.label,
        type: column.type === 'money' || column.type === 'date' ? column.type : 'text',
        width: column.type === 'money' ? 24 : Math.max(18, Math.min(40, column.width / 3)),
      }));
      const worksheet = sheet(section.title, columns);
      worksheet.getCell('A6').value =
        `${statement.customer.name} / ${statement.customer.reference}`;
      worksheet.getCell('A6').font = { name: 'Arial', size: 10, color: { argb: color.ink } };
      writeTable(worksheet, columns, section.rows, 8);
    }
  } else {
    const columns = exportColumns(input.rows);
    const worksheet = sheet(input.title, columns);
    let header = 7;
    const filters = Object.entries(input.filters ?? {}).filter(
      ([key, value]) => key !== 'kind' && value != null && value !== '',
    );
    for (const [key, value] of filters) {
      worksheet.getCell(header, 1).value = `${exportLabel(key)}: ${String(value)}`;
      worksheet.getCell(header, 1).font = { name: 'Arial', size: 10, color: { argb: color.muted } };
      header++;
    }
    if (filters.length) header++;
    writeTable(worksheet, columns, input.rows, header);
    if (Object.keys(input.summary ?? {}).length) {
      const summaryColumns: ExportColumn[] = [
        { key: 'metric', label: 'Metric', type: 'text', width: 38 },
        { key: 'value', label: 'Value', type: 'text', width: 28 },
      ];
      const summary = sheet('Summary', summaryColumns);
      const metrics = Object.entries(input.summary!).map(([key, value]) => ({
        metric: exportLabel(key),
        value: typeof value === 'boolean' ? (value ? 'Balanced' : 'Out of balance') : String(value),
      }));
      writeTable(summary, summaryColumns, metrics, 7);
      Object.entries(input.summary!).forEach(([key, value], index) => {
        if (typeof value === 'boolean') return;
        const column = exportColumns([{ [key]: value as string }])[0]!;
        const cell = summary.getCell(index + 8, 2);
        cell.value = column.type === 'percent' ? Number(value) / 100 : excelNumber(value);
        cell.numFmt =
          column.type === 'percent'
            ? '0.0%'
            : column.type === 'money'
              ? '#,##0.00;[Red](#,##0.00);0.00'
              : '#,##0';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      });
    }
  }
  return workbook;
}
