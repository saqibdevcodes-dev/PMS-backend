import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { Registry, Counter, collectDefaultMetrics } from '@prometheus-io/client';
import { randomUUID } from 'node:crypto';
import { ZodError, z } from 'zod';
import { Prisma } from '@prisma/client';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { env } from './config/env.js';
import { db } from './database/client.js';
import { redis, throttle } from './integrations/redis.js';
import { storage } from './integrations/storage.js';
import { AppError } from './common/errors.js';
import { endpoint, pageQuery, id, paged, pagination } from './common/http.js';
import { portalRoutes } from './modules/portal/routes.js';
import { imageRoutes } from './modules/images/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { foundationRoutes } from './modules/foundation/routes.js';
import { salesRoutes } from './modules/sales/routes.js';
import { workflowRoutes } from './modules/workflows/routes.js';
import { crmRoutes } from './modules/crm/routes.js';
import { financeRoutes } from './modules/finance/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { documentRoutes } from './modules/documents/routes.js';
import { buildOpenApi } from './docs/openapi.js';
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: ['password', 'token', 'refreshToken', 'accessToken', 'authorization', 'cookie'],
});
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'pms_' });
  const requests = new Counter({
    name: 'pms_http_requests_total',
    help: 'Completed HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  app.use((req, res, next) => {
    res.once('finish', () =>
      requests.inc({
        method: req.method,
        route: req.route?.path ?? 'unmatched',
        status: String(res.statusCode),
      }),
    );
    next();
  });
  app.use((req, res, next) => {
    const supplied = req.headers['x-request-id'];
    res.locals.requestId =
      typeof supplied === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(supplied)
        ? supplied
        : randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId as string);
    next();
  });
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req) => ({ method: req.method, path: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customProps: (_req, res) => ({ requestId: res.locals?.requestId }),
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(
          origin && !env.TRUSTED_ORIGINS.includes(origin)
            ? new AppError(403, 'ORIGIN_REJECTED', 'Origin is not allowed.')
            : null,
          true,
        ),
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Request-Id',
        'X-Client-Version',
      ],
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await Promise.all([
        db.$queryRaw`SELECT 1`,
        redis.ping(),
        storage.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET })),
      ]);
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use('/api', async (req, _res, next) => {
    if (env.NODE_ENV === 'production' && !req.secure)
      throw new AppError(400, 'HTTPS_REQUIRED', 'HTTPS is required.');
    if (!(await throttle(`api:${req.ip ?? 'unknown'}`, 300, 60)))
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
    const client = req.headers['x-client-version'];
    if (client) {
      const version = z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .parse(client)
        .split('.')
        .map(Number);
      const minimum = env.MIN_CLIENT_VERSION.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (version[i]! < minimum[i]!)
          throw new AppError(426, 'CLIENT_UPGRADE_REQUIRED', 'Please update your application.');
        if (version[i]! > minimum[i]!) break;
      }
    }
    next();
  });
  endpoint(
    app,
    'get',
    '/compatibility',
    { public: true, summary: 'Client compatibility contract' },
    async () => ({
      apiVersion: 'v1',
      minimumClientVersion: env.MIN_CLIENT_VERSION,
      platforms: ['web', 'electron', 'android', 'ios'],
      onlineRequired: true,
    }),
  );
  endpoint(
    app,
    'get',
    '/metrics',
    { permission: 'users.manage', summary: 'Authenticated Prometheus metrics' },
    async (_ctx, _b, _q, _req, res) => {
      res.type(registry.contentType).send(await registry.metrics());
    },
  );
  authRoutes(app);
  portalRoutes(app);
  imageRoutes(app);
  foundationRoutes(app);
  salesRoutes(app);
  workflowRoutes(app);
  crmRoutes(app);
  financeRoutes(app);
  documentRoutes(app);
  reportRoutes(app);
  endpoint(
    app,
    'get',
    '/notifications',
    { summary: 'List your in-app notification history', query: pageQuery },
    async (ctx, _b, q) => {
      const where = { userId: ctx.actor.id };
      const [items, total] = await Promise.all([
        db.notification.findMany({ where, ...pagination(q), orderBy: { createdAt: q.sort } }),
        db.notification.count({ where }),
      ]);
      return paged(items, total, q);
    },
  );
  endpoint(
    app,
    'post',
    '/notifications/:id/read',
    { summary: 'Mark your notification as read' },
    async (ctx, _b, _q, req) => {
      await db.notification.updateMany({
        where: { id: id(req), userId: ctx.actor.id },
        data: { readAt: new Date() },
      });
      return { read: true };
    },
  );
  app.get('/api/v1/openapi.json', (_req, res) => res.json(buildOpenApi()));
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')));
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    let status = 500,
      code = 'INTERNAL_ERROR',
      message = 'The request could not be completed.',
      details: unknown;
    if (error instanceof AppError) {
      ({ status, code, message, details } = error);
    } else if (error instanceof ZodError) {
      status = 422;
      code = 'VALIDATION_ERROR';
      message = 'Request validation failed.';
      details = error.issues.map((i) => ({ path: i.path, message: i.message }));
    } else if (error instanceof SyntaxError && 'body' in error) {
      status = 400;
      code = 'MALFORMED_JSON';
      message = 'Malformed JSON body.';
    } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        status = 409;
        code = 'DUPLICATE_RECORD';
        message = 'A conflicting record already exists.';
      } else if (error.code === 'P2025') {
        status = 404;
        code = 'NOT_FOUND';
        message = 'Record not found.';
      } else if (['P2003', 'P2004', 'P2034'].includes(error.code)) {
        status = 409;
        code = 'BUSINESS_CONFLICT';
        message = 'This operation conflicts with existing business records.';
      }
    } else if (error?.code === 'LIMIT_FILE_SIZE') {
      status = 413;
      code = 'FILE_TOO_LARGE';
      message = 'Maximum file size is 10 MiB.';
    } else if (error?.type === 'entity.too.large') {
      status = 413;
      code = 'REQUEST_TOO_LARGE';
      message = 'Request body is too large.';
    }
    if (status === 500) {
      logger.error(
        {
          requestId: res.locals.requestId,
          path: req.path,
          errorType: error instanceof Error ? error.name : 'Unknown',
        },
        'Unhandled request error',
      );
      if (env.NODE_ENV === 'test') console.error(error);
    }
    res.status(status).json({
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      meta: { requestId: res.locals.requestId },
    });
  };
  app.use(errors);
  return app;
}
