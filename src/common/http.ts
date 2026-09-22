import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Context } from './context.js';
import { AppError } from './errors.js';
import { authenticate } from '../modules/auth/service.js';
import { db } from '../database/client.js';
export const uuid = z.uuid();
export const date = z.iso.date();
export const password = z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/);
export const pageQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().max(200).optional(),
    status: z.string().max(40).optional(),
    from: date.optional(),
    to: date.optional(),
    sort: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type PageQuery = z.infer<typeof pageQuery>;
export const paginationQuery = pageQuery.pick({ page: true, limit: true, sort: true });
export function pagination(q: PageQuery) {
  return { skip: (q.page - 1) * q.limit, take: q.limit };
}
export function paged<T>(items: T[], total: number, q: PageQuery) {
  return {
    items,
    pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
}
type RouteDoc = {
  method: string;
  path: string;
  permission?: string;
  public?: boolean;
  summary: string;
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  multipart?: boolean;
  status?: number;
};
export const routeDocs: RouteDoc[] = [];
export function endpoint<
  B extends z.ZodType = z.ZodObject<Record<string, never>>,
  Q extends z.ZodType = z.ZodObject<Record<string, never>>,
>(
  app: Express,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  options: Omit<RouteDoc, 'method' | 'path' | 'body' | 'query'> & {
    body?: B;
    query?: Q;
    status?: number;
  },
  handler: (
    ctx: Context,
    body: z.infer<B>,
    query: z.infer<Q>,
    req: Request,
    res: Response,
  ) => Promise<unknown>,
) {
  routeDocs.push({ method, path, ...options });
  app[method]('/api/v1' + path, async (req, res) => {
    for (const [key, value] of Object.entries(req.params))
      if (key.endsWith('Id') || key === 'id') uuid.parse(value);
    const actor = options.public
      ? { id: '', sessionId: '', permissions: new Set<string>() }
      : await authenticate(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (options.permission && !actor.permissions.has(options.permission))
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission for this operation.');
    const projectId = (req.params.projectId as string | undefined) ?? '';
    if (
      projectId &&
      !(await db.userProjectAccess.findUnique({
        where: { userId_projectId: { userId: actor.id, projectId } },
      }))
    )
      throw new AppError(404, 'NOT_FOUND', 'The requested project was not found.');
    const body = (options.body ?? z.object({}).strict()).parse(req.body ?? {}) as z.infer<B>;
    const query = (options.query ?? z.object({}).strict()).parse(req.query) as z.infer<Q>;
    const ctx = { actor, projectId, requestId: res.locals.requestId as string };
    const data = await handler(ctx, body, query, req, res);
    if (!res.headersSent)
      res
        .status(options.status ?? 200)
        .json({ success: true, data, meta: { requestId: ctx.requestId } });
  });
}
export function idempotencyKey(req: Request) {
  return z
    .string()
    .min(8)
    .max(128)
    .regex(/^[\w-]+$/)
    .parse(req.headers['idempotency-key']);
}
export const id = (req: Request) => req.params.id as string;
