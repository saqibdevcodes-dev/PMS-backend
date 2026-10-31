import type { Express } from 'express';
import { z } from 'zod';
import { db } from '../../database/client.js';
import { endpoint, id } from '../../common/http.js';
import { found, requireState } from '../../common/errors.js';
import { dashboard, report, reportQuery, queueExport, dealsProfitability } from './service.js';
import { signedDownload } from '../../integrations/storage.js';
import { calendarRoutes } from './calendar.js';
const root = '/projects/:projectId';
export function reportRoutes(app: Express) {
  calendarRoutes(app);
  endpoint(
    app,
    'get',
    root + '/dashboard',
    {
      permission: 'reports.read',
      summary: 'Reconciled inventory, sales and collection KPIs; cache age at most 15 seconds',
      query: z.object({ phase: z.string().max(100).optional() }).strict(),
    },
    async (ctx, _b, q) => dashboard(ctx.projectId, q.phase),
  );
  endpoint(
    app,
    'get',
    root + '/deal-profitability',
    {
      permission: 'reports.read',
      summary: 'Property acquisition, renovation expenses, buyer resale prices, and profit margins',
    },
    async (ctx) => dealsProfitability(ctx.projectId),
  );
  endpoint(
    app,
    'get',
    root + '/reports',
    {
      permission: 'reports.read',
      summary: 'Project-scoped operational or accounting report; maximum 1000 rows',
      query: reportQuery,
    },
    async (ctx, _b, q) => {
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
          ctx.actor.permissions.has('finance.read'),
          'FORBIDDEN',
          'Financial reporting permission is required.',
          403,
        );
      return report(ctx.projectId, q);
    },
  );
  endpoint(
    app,
    'post',
    root + '/reports/exports',
    {
      permission: 'reports.export',
      summary: 'Queue a private XLSX or PDF report export',
      body: z.object({ report: reportQuery, format: z.enum(['xlsx', 'pdf']) }).strict(),
      status: 202,
    },
    async (ctx, b) => {
      if (
        [
          'ledger',
          'vendor-ledger',
          'cash-book',
          'bank-book',
          'trial-balance',
          'income-statement',
          'balance-sheet',
        ].includes(b.report.kind)
      )
        requireState(
          ctx.actor.permissions.has('finance.read'),
          'FORBIDDEN',
          'Financial reporting permission is required.',
          403,
        );
      return queueExport(ctx, b);
    },
  );
  endpoint(
    app,
    'get',
    root + '/jobs/:id',
    { permission: 'reports.export', summary: 'Read your own background job state' },
    async (ctx, _b, _q, req) =>
      found(
        await db.backgroundJob.findFirst({
          where: { id: id(req), projectId: ctx.projectId, createdBy: ctx.actor.id },
        }),
      ),
  );
  endpoint(
    app,
    'get',
    root + '/jobs/:id/download',
    { permission: 'reports.export', summary: 'Get expiring private URL for your completed export' },
    async (ctx, _b, _q, req) => {
      const job = found(
        await db.backgroundJob.findFirst({
          where: { id: id(req), projectId: ctx.projectId, createdBy: ctx.actor.id },
        }),
      );
      if (job.kind === 'REPORT') {
        const input = z.object({ report: reportQuery }).parse(job.payload);
        if (
          [
            'ledger',
            'vendor-ledger',
            'cash-book',
            'bank-book',
            'trial-balance',
            'income-statement',
            'balance-sheet',
          ].includes(input.report.kind)
        )
          requireState(
            ctx.actor.permissions.has('finance.read'),
            'FORBIDDEN',
            'Financial reporting permission is required.',
            403,
          );
      } else
        requireState(
          ctx.actor.permissions.has('documents.read'),
          'FORBIDDEN',
          'Document access is required.',
          403,
        );
      if (job.status !== 'COMPLETED' || !job.resultKey) {
        const { generateArtifact } = await import('../../jobs/artifacts.js');
        await generateArtifact(job.id);
        const updated = await db.backgroundJob.findUnique({ where: { id: job.id } });
        if (updated?.status === 'COMPLETED' && updated.resultKey) {
          return { url: await signedDownload(updated.resultKey), expiresIn: 120 };
        }
      }
      requireState(
        job.status === 'COMPLETED' && job.resultKey,
        'JOB_NOT_COMPLETE',
        'The export is not complete.',
      );
      return { url: await signedDownload(job.resultKey), expiresIn: 120 };
    },
  );
}
