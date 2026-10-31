import { z } from 'zod';
import { db, transaction, lock } from '../database/client.js';
import { report, reportQuery } from '../modules/reports/service.js';
import { putObject } from '../integrations/storage.js';
import { found, requireState } from '../common/errors.js';
import { emailUser, webLink } from '../common/notifications.js';
import { statementPdf } from './statement-pdf.js';
import { projectBranding } from './project-branding.js';
import { pdfBuffer } from './report-pdf.js';
import { reportWorkbook } from './report-xlsx.js';
import { exportLabel } from './export-format.js';
export { pdfBuffer } from './report-pdf.js';
export async function generateArtifact(jobId: string) {
  const job = found(await db.backgroundJob.findUnique({ where: { id: jobId } }));
  if (job.status === 'COMPLETED') return;
  await db.backgroundJob.update({
    where: { id: job.id },
    data: { status: 'PROCESSING', error: null },
  });
  try {
    // Recheck the requesting user's current project assignment before exposing any data.
    found(
      await db.userProjectAccess.findUnique({
        where: { userId_projectId: { userId: job.createdBy, projectId: job.projectId } },
      }),
    );
    const user = found(
      await db.user.findUnique({
        where: { id: job.createdBy },
        include: { roles: { include: { role: { include: { permissions: true } } } } },
      }),
    );
    const grants = new Set(
      user.roles.flatMap((r) => r.role.permissions.map((p) => p.permissionKey)),
    );
    requireState(
      user.active &&
        grants.has('reports.export') &&
        (job.kind !== 'DOCUMENT' || grants.has('documents.manage')),
      'EXPORT_ACCESS_REVOKED',
      'The requesting user no longer has export access.',
      403,
    );
    if (job.kind === 'REPORT') {
      const q = z.object({ report: reportQuery }).parse(job.payload).report;
      if (
        [
          'ledger',
          'vendor-ledger',
          'cash-book',
          'bank-book',
          'trial-balance',
          'income-statement',
          'balance-sheet',
        ].includes(q.kind)
      )
        requireState(
          grants.has('finance.read'),
          'EXPORT_ACCESS_REVOKED',
          'Financial reporting permission has been revoked.',
          403,
        );
    }
    let body: Buffer;
    let extension: string;
    let mime: string;
    const branding = await projectBranding(job.projectId);
    if (job.kind === 'REPORT') {
      const input = z
        .object({ report: reportQuery, format: z.enum(['xlsx', 'pdf']) })
        .parse(job.payload);
      const result = await report(job.projectId, input.report, 50000);
      extension = input.format;
      if (input.format === 'xlsx') {
        const workbook = reportWorkbook({
          title: exportLabel(input.report.kind) + ' report',
          projectName: branding.name,
          currency: result.currency,
          timezone: branding.timezone,
          generatedAt: new Date().toISOString(),
          rows: result.rows,
          summary: result.summary,
          filters: input.report,
          ...('statement' in result && result.statement ? { statement: result.statement } : {}),
        });
        body = Buffer.from(await workbook.xlsx.writeBuffer());
        mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else {
        body =
          'statement' in result && result.statement
            ? await statementPdf(result.statement, branding)
            : await pdfBuffer(exportLabel(input.report.kind) + ' report', result.rows, branding, {
                currency: result.currency,
                timezone: branding.timezone,
                filters: input.report,
              });
        mime = 'application/pdf';
      }
    } else {
      const input = z.object({ templateId: z.uuid(), bookingId: z.uuid() }).parse(job.payload);
      const template = found(
        await db.documentTemplate.findFirst({
          where: { id: input.templateId, projectId: job.projectId },
        }),
      );
      const booking = found(
        await db.booking.findFirst({
          where: { id: input.bookingId, unit: { projectId: job.projectId } },
          include: { unit: true, customer: { select: { name: true } } },
        }),
      );
      const variables: Record<string, string> = {
        customerName: booking.customer.name,
        bookingReference: booking.reference,
        unitNumber: booking.unit.number,
        total: booking.total.toFixed(2),
        status: booking.status,
        date: new Date().toISOString().slice(0, 10),
      };
      const content = template.body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        requireState(
          key in variables,
          'UNKNOWN_TEMPLATE_VARIABLE',
          'Unsupported template variable.',
          422,
        );
        return variables[key]!;
      });
      body = await pdfBuffer(template.name, content, branding);
      extension = 'pdf';
      mime = 'application/pdf';
    }
    const key = `projects/${job.projectId}/exports/${job.id}.${extension}`;
    await putObject(key, body, mime);
    await transaction(async (tx) => {
      await lock(tx, 'BackgroundJob', job.id);
      if (
        (await tx.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status === 'COMPLETED'
      )
        return;
      await tx.backgroundJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', resultKey: key },
      });
      await emailUser(
        tx,
        job.createdBy,
        job.kind === 'REPORT' ? 'Your report is ready' : 'Your document is ready',
        `Your requested ${job.kind === 'REPORT' ? 'report' : 'document'} has been generated.\nJob reference: ${job.id}\n\nSign in to download it securely: ${webLink()}`,
      );
    });
  } catch (error) {
    await db.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        error: 'Generation failed; review worker logs using the job identifier.',
      },
    });
    throw error;
  }
}
