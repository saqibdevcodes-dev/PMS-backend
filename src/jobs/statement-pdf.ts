import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drawDocumentBrand, type DocumentBranding } from './project-branding.js';
import { DateTime } from 'luxon';
import {
  type AccountStatement,
  type StatementColumn,
  statementValue,
} from '../modules/reports/statement-format.js';

const ink = '#203249',
  blue = '#355e85',
  muted = '#65758a',
  line = '#dfe6ee';

export function statementPdf(
  statement: AccountStatement,
  branding?: DocumentBranding,
): Promise<Buffer> {
  return new Promise((resolvePdf, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 42,
      bufferPages: true,
      info: {
        Title: 'Customer account statement',
        Author: branding?.name ?? 'Etihad Real Estate',
        Subject: statement.customer.reference,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const left = 42,
        width = doc.page.width - 84,
        bottom = doc.page.height - 62;
      let y = 42;
      const logo = resolve('assets/statement-logo.png');
      const text = (
        value: string,
        x: number,
        top: number,
        w: number,
        size = 9,
        bold = false,
        color = ink,
        align: 'left' | 'right' = 'left',
      ) => {
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(size)
          .fillColor(color)
          .text(value, x, top, { width: w, align, lineGap: 3 });
        return doc.y;
      };
      const height = (value: string, w: number, size: number, bold = false) =>
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(size)
          .heightOfString(value, { width: w, lineGap: 3 });
      const rule = (top: number) =>
        doc
          .moveTo(left, top)
          .lineTo(left + width, top)
          .lineWidth(0.5)
          .strokeColor(line)
          .stroke();
      const newPage = () => {
        doc.addPage();
        text(branding?.name ?? 'ETIHAD REAL ESTATE', left, 32, width / 2, 9, true, blue);
        text('ACCOUNT STATEMENT', left + width / 2, 32, width / 2, 8, false, muted, 'right');
        rule(53);
        y = 70;
      };
      const ensure = (required: number) => {
        if (y + required > bottom) newPage();
      };
      const note = (value: string) => {
        const h = height(value, width - 24, 8.5) + 22;
        ensure(h);
        doc.roundedRect(left, y, width, h, 5).fill('#f2f6fa');
        text(value, left + 12, y + 10, width - 24, 8.5, false, muted);
        y += h + 9;
      };
      if (branding) drawDocumentBrand(doc, branding, left, y);
      else if (existsSync(logo)) doc.image(logo, left, y, { fit: [156, 49] });
      else text('ETIHAD\nREAL ESTATE', left, y, width / 2, 14, true, blue);
      text('CUSTOMER COPY', left + width / 2, y + 3, width / 2, 8, true, blue, 'right');
      text(
        'Issued ' +
          DateTime.fromISO(statement.generatedAt, { zone: statement.project.timezone }).toFormat(
            'dd MMM yyyy, HH:mm',
          ),
        left + width / 2,
        y + 20,
        width / 2,
        8,
        false,
        muted,
        'right',
      );
      y += 68;
      text('Account statement', left, y, width, 26, true);
      y += 38;
      y = text(statement.project.name, left, y, width, 11, false, muted) + 18;
      const customerLines = [
        statement.customer.name,
        statement.customer.reference,
        statement.customer.email,
        statement.customer.phone,
      ]
        .filter(Boolean)
        .join('\n');
      const period =
        statement.from || statement.to
          ? `${statement.from ?? 'Beginning'} to ${statement.to ?? 'Present'}`
          : 'All recorded payments';
      const detail = [
        statement.reference,
        'Payment period',
        period,
        `Currency: ${statement.project.currency}`,
      ]
        .filter(Boolean)
        .join('\n');
      const detailsHeight =
        Math.max(
          height(customerLines, width * 0.55 - 30, 10),
          height(detail, width * 0.45 - 30, 9),
        ) + 43;
      ensure(detailsHeight);
      doc
        .roundedRect(left, y, width, detailsHeight, 7)
        .lineWidth(0.7)
        .fillAndStroke('#f8fafc', line);
      text('PREPARED FOR', left + 16, y + 14, width / 2, 8, true, blue);
      text(customerLines, left + 16, y + 32, width * 0.55 - 30, 10);
      text(detail, left + width * 0.55, y + 20, width * 0.45 - 16, 9, false, muted);
      y += detailsHeight + 22;
      ensure(90);
      const gap = 10,
        cardWidth = (width - gap * 2) / 3;
      statement.metrics.slice(0, 3).forEach((metric, index) => {
        const x = left + index * (cardWidth + gap);
        doc.roundedRect(x, y, cardWidth, 78, 6).fill(metric.emphasis ? blue : '#eef3f8');
        text(
          metric.label.toUpperCase(),
          x + 12,
          y + 13,
          cardWidth - 24,
          7.2,
          true,
          metric.emphasis ? '#dce8f3' : muted,
        );
        const value = statementValue(
          metric.amount,
          { key: '', label: '', type: 'money', width: 0 },
          statement,
        );
        let size = 17;
        while (
          size > 9 &&
          doc.font('Helvetica-Bold').fontSize(size).widthOfString(value) > cardWidth - 24
        )
          size--;
        text(value, x + 12, y + 31, cardWidth - 24, size, true, metric.emphasis ? '#ffffff' : ink);
        text(
          statement.project.currency,
          x + 12,
          y + 58,
          cardWidth - 24,
          7.5,
          false,
          metric.emphasis ? '#dce8f3' : muted,
        );
      });
      y += 98;
      for (const value of statement.notes) note(value);
      y += 9;

      for (const section of statement.sections) {
        const unit = width / section.columns.reduce((sum, c) => sum + c.width, 0);
        const columnWidth = (column: StatementColumn) => column.width * unit;
        const headingHeight = height(section.description, width, 8.5);
        ensure(90 + headingHeight);
        const heading = (continued = false) => {
          text(section.title + (continued ? ' (continued)' : ''), left, y, width, 13, true);
          y += 23;
          if (!continued) {
            y = text(section.description, left, y, width, 8.5, false, muted) + 12;
          }
          doc.rect(left, y, width, 29).fill('#eaf0f6');
          let x = left;
          for (const col of section.columns) {
            text(
              col.label,
              x + 8,
              y + 9,
              columnWidth(col) - 16,
              7.5,
              true,
              blue,
              col.type === 'money' ? 'right' : 'left',
            );
            x += columnWidth(col);
          }
          y += 29;
        };
        heading();
        if (!section.rows.length) {
          text('No entries for this period.', left + 10, y + 14, width - 20, 9, false, muted);
          y += 43;
        }
        for (const [index, row] of section.rows.entries()) {
          const values = section.columns.map((col) => statementValue(row[col.key], col, statement));
          const rowHeight = Math.max(
            34,
            ...values.map((v, i) => height(v, columnWidth(section.columns[i]!) - 16, 8) + 18),
          );
          if (y + rowHeight > bottom) {
            newPage();
            heading(true);
          }
          if (index % 2 === 0) doc.rect(left, y, width, rowHeight).fill('#f8fafc');
          let x = left;
          section.columns.forEach((col, i) => {
            text(
              values[i]!,
              x + 8,
              y + 9,
              columnWidth(col) - 16,
              8,
              col.type === 'money',
              ink,
              col.type === 'money' ? 'right' : 'left',
            );
            x += columnWidth(col);
          });
          y += rowHeight;
          rule(y);
        }
        y += 27;
      }
      ensure(42);
      text('Questions about your statement?', left, y, width, 9, true, blue);
      text(
        'Contact the property office with your customer or booking reference.',
        left,
        y + 17,
        width,
        8.5,
        false,
        muted,
      );
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        const bottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        rule(doc.page.height - 46);
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(muted)
          .text('Etihad Real Estate | Account statement', left, doc.page.height - 33, {
            width: width - 90,
            lineBreak: false,
          })
          .text(`Page ${i + 1} of ${pages.count}`, left + width - 90, doc.page.height - 33, {
            width: 90,
            align: 'right',
            lineBreak: false,
          });
        doc.page.margins.bottom = bottomMargin;
      }
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}
