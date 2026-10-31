import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import type { ReportRow } from '../modules/reports/service.js';
import { drawDocumentBrand, type DocumentBranding } from './project-branding.js';
import {
  exportAmountWords,
  exportColumns,
  exportLabel,
  exportPalette,
  exportValue,
  type ExportColumn,
} from './export-format.js';

export type PdfReportOptions = {
  currency?: string;
  timezone?: string;
  generatedAt?: string;
  filters?: Record<string, unknown>;
};

/** Paper tables with repeated headings and column bands for wide reports. */
export function pdfBuffer(
  title: string,
  rows: ReportRow[] | string,
  branding?: DocumentBranding,
  options: PdfReportOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const columns = typeof rows === 'string' ? [] : exportColumns(rows);
    const doc = new PDFDocument({
      size: 'A4',
      layout: columns.length > 5 ? 'landscape' : 'portrait',
      margin: 40,
      bufferPages: true,
      info: { Title: title, Author: branding?.name ?? 'Etihad Real Estate' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const left = 40,
        width = doc.page.width - 80,
        bottom = doc.page.height - 54;
      const color = Object.fromEntries(
        Object.entries(exportPalette).map(([key, value]) => [key, '#' + value]),
      );
      const generated = DateTime.fromISO(options.generatedAt ?? new Date().toISOString(), {
        zone: options.timezone ?? 'Asia/Karachi',
      }).toFormat('dd MMM yyyy, HH:mm');
      let y = 40;
      function text(
        value: string,
        x: number,
        top: number,
        w: number,
        size = 9,
        bold = false,
        align: 'left' | 'right' = 'left',
        ink = color.ink!,
      ) {
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(size)
          .fillColor(ink)
          .text(value, x, top, { width: w, align, lineGap: 2, lineBreak: false });
      }
      function rule(top: number) {
        doc
          .moveTo(left, top)
          .lineTo(left + width, top)
          .lineWidth(0.5)
          .strokeColor(color.border!)
          .stroke();
      }
      function lines(value: string, w: number, size = 8, bold = false) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
        const result: string[] = [];
        for (const paragraph of value.split(/\r?\n/)) {
          let line = '';
          for (const word of paragraph.split(/\s+/)) {
            if (!word) continue;
            let rest = word;
            if (line && doc.widthOfString(`${line} ${rest}`) > w) {
              result.push(line);
              line = '';
            }
            while (doc.widthOfString(rest) > w) {
              let end = 1;
              while (end < rest.length && doc.widthOfString(rest.slice(0, end + 1)) <= w) end++;
              result.push(rest.slice(0, end));
              rest = rest.slice(end);
            }
            line = line ? `${line} ${rest}` : rest;
          }
          result.push(line);
        }
        return result.length ? result : [''];
      }
      function header(continued: boolean, band?: string) {
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(color.paper!);
        if (branding && !continued) drawDocumentBrand(doc, branding, left, 34, 140, 44);
        else
          text(
            branding?.name ?? 'Etihad Real Estate',
            left,
            34,
            width / 2,
            10,
            true,
            'left',
            color.blue!,
          );
        text(
          `Generated ${generated}`,
          left + width / 2,
          36,
          width / 2,
          8,
          false,
          'right',
          color.muted!,
        );
        const titleLines = lines(title, width, continued ? 14 : 19, true);
        y = continued ? 60 : 94;
        for (const line of titleLines) {
          text(line, left, y, width, continued ? 14 : 19, true);
          y += continued ? 20 : 25;
        }
        const context = [
          options.currency ? `Currency: ${options.currency}` : '',
          band ?? '',
          typeof rows === 'string' ? '' : `${rows.length.toLocaleString()} records`,
        ]
          .filter(Boolean)
          .join(' / ');
        if (context) {
          text(context, left, y + 3, width, 8, false, 'left', color.muted!);
          y += 23;
        }
        if (!continued) {
          const filters = Object.entries(options.filters ?? {})
            .filter(([key, value]) => key !== 'kind' && value != null && value !== '')
            .map(([key, value]) => `${exportLabel(key)}: ${String(value)}`)
            .join(' / ');
          for (const line of lines(filters, width, 8))
            if (line) {
              text(line, left, y, width, 8, false, 'left', color.muted!);
              y += 13;
            }
        }
        rule(y + 2);
        y += 17;
      }
      if (typeof rows === 'string') {
        header(false);
        for (const paragraph of rows.split(/\r?\n/)) {
          for (const line of lines(paragraph, width, 10)) {
            if (y + 16 > bottom) {
              doc.addPage();
              header(true);
            }
            text(line, left, y, width, 10);
            y += 15;
          }
          y += 7;
        }
      } else if (!rows.length) {
        header(false);
        text(
          'No entries for the selected period.',
          left,
          y + 12,
          width,
          10,
          false,
          'left',
          color.muted!,
        );
      } else {
        const anchor =
          columns.find((column) => /^(reference|number|name|title|id)$/.test(column.key)) ??
          columns[0]!;
        const rest = columns.filter((column) => column !== anchor);
        const bands: ExportColumn[][] =
          columns.length <= 7
            ? [columns]
            : Array.from({ length: Math.ceil(rest.length / 6) }, (_, index) => [
                anchor,
                ...rest.slice(index * 6, index * 6 + 6),
              ]);
        for (const [bandIndex, band] of bands.entries()) {
          if (bandIndex) doc.addPage();
          const context =
            bands.length > 1 ? `Column group ${bandIndex + 1} of ${bands.length}` : undefined;
          const totalWeight = band.reduce(
            (total, column) => total + (column.type === 'money' ? 26 : Math.min(column.width, 32)),
            0,
          );
          const widths = band.map(
            (column) =>
              (width * (column.type === 'money' ? 26 : Math.min(column.width, 32))) / totalWeight,
          );
          const headingLines = band.map((column, index) =>
            lines(column.label, widths[index]! - 16, 8, true),
          );
          const headerHeight = Math.max(
            30,
            ...headingLines.map((values) => values.length * 11 + 16),
          );
          const tableHeader = (continued: boolean) => {
            header(continued, context);
            doc.rect(left, y, width, headerHeight).fill(color.header!);
            let x = left;
            band.forEach((column, index) => {
              headingLines[index]!.forEach((line, lineIndex) =>
                text(
                  line,
                  x + 8,
                  y + 8 + lineIndex * 11,
                  widths[index]! - 16,
                  8,
                  true,
                  ['money', 'number', 'percent'].includes(column.type) ? 'right' : 'left',
                ),
              );
              x += widths[index]!;
            });
            y += headerHeight;
          };
          tableHeader(bandIndex > 0);
          rows.forEach((row, rowIndex) => {
            const cells = band.map((column, index) => {
              const formatted = exportValue(row[column.key], column, options.timezone);
              const words =
                column.type === 'money' && options.currency && formatted !== '-'
                  ? exportAmountWords(row[column.key], options.currency)
                  : '';
              return lines(words ? `${formatted}\n${words}` : formatted, widths[index]! - 16);
            });
            const lineCount = Math.max(...cells.map((cell) => cell.length));
            let offset = 0;
            while (offset < lineCount) {
              if (y + 28 > bottom) {
                doc.addPage();
                tableHeader(true);
              }
              const available = Math.max(1, Math.floor((bottom - y - 16) / 11));
              const count = Math.min(lineCount - offset, available);
              const h = Math.max(28, count * 11 + 16);
              doc.rect(left, y, width, h).fill(rowIndex % 2 ? color.stripe! : color.paper!);
              let x = left;
              band.forEach((column, index) => {
                cells[index]!.slice(offset, offset + count).forEach((line, lineIndex) =>
                  text(
                    line,
                    x + 8,
                    y + 8 + lineIndex * 11,
                    widths[index]! - 16,
                    8,
                    false,
                    ['money', 'number', 'percent'].includes(column.type) ? 'right' : 'left',
                  ),
                );
                x += widths[index]!;
              });
              y += h;
              rule(y);
              offset += count;
            }
          });
        }
      }
      const pages = doc.bufferedPageRange();
      for (let page = 0; page < pages.count; page++) {
        doc.switchToPage(page);
        const margin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        rule(doc.page.height - 39);
        text(
          branding?.name ?? 'Etihad Real Estate',
          left,
          doc.page.height - 28,
          width - 110,
          7,
          false,
          'left',
          color.muted!,
        );
        text(
          `Page ${page + 1} of ${pages.count}`,
          left + width - 110,
          doc.page.height - 28,
          110,
          7,
          false,
          'right',
          color.muted!,
        );
        doc.page.margins.bottom = margin;
      }
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}
