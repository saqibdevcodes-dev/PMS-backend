import type { Express, Response, Request } from 'express';
import { z } from 'zod';
import { endpoint, password, uuid } from '../../common/http.js';
import { env } from '../../config/env.js';
import { AppError, found } from '../../common/errors.js';
import { db } from '../../database/client.js';
import * as auth from './service.js';
const loginBody = z
  .object({
    email: z.email().toLowerCase(),
    password: z.string().max(128),
    deviceId: z.string().max(100).optional(),
  })
  .strict();
const tokenBody = z.object({ refreshToken: z.string().min(32).max(200) }).strict();
const cookieName = 'pms_refresh';
const cookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/api/v1/auth/refresh',
};
function browserOrigin(req: Request) {
  const origin = req.headers.origin;
  if (!origin || !env.TRUSTED_ORIGINS.includes(origin))
    throw new AppError(403, 'CSRF_ORIGIN_REJECTED', 'A trusted Origin header is required.');
}
function webResult(result: Awaited<ReturnType<typeof auth.login>>, res: Response) {
  res.cookie(cookieName, result.refreshToken, {
    ...cookieOptions,
    expires: result.refreshExpiresAt,
  });
  return {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    sessionId: result.sessionId,
  };
}
export function authRoutes(app: Express) {
  endpoint(
    app,
    'post',
    '/auth/login',
    {
      public: true,
      audience: 'authenticated',
      summary: 'Web login; refresh token is an HttpOnly cookie',
      body: loginBody,
    },
    async (ctx, body, _q, req, res) => {
      browserOrigin(req);
      return webResult(await auth.login(body, 'web', ctx.requestId), res);
    },
  );
  endpoint(
    app,
    'post',
    '/auth/refresh',
    { public: true, audience: 'authenticated', summary: 'Rotate web refresh cookie' },
    async (_ctx, _body, _q, req, res) => {
      browserOrigin(req);
      const token = tokenBody.shape.refreshToken.safeParse(req.cookies?.[cookieName]);
      if (!token.success) {
        res.clearCookie(cookieName, cookieOptions);
        throw new AppError(401, 'SESSION_EXPIRED', 'Please sign in again.');
      }
      return webResult(await auth.refresh(token.data, false), res);
    },
  );
  endpoint(
    app,
    'post',
    '/auth/native/login',
    {
      public: true,
      audience: 'authenticated',
      summary: 'Native login; store refresh token in OS secure storage',
      body: loginBody.extend({ platform: z.enum(['electron', 'android', 'ios']) }),
    },
    async (ctx, body) => auth.login(body, body.platform, ctx.requestId),
  );
  endpoint(
    app,
    'post',
    '/auth/native/refresh',
    {
      public: true,
      audience: 'authenticated',
      summary: 'Rotate native refresh token',
      body: tokenBody,
    },
    async (_ctx, body) => auth.refresh(body.refreshToken, true),
  );
  for (const all of [false, true])
    endpoint(
      app,
      'post',
      all ? '/auth/logout-all' : '/auth/logout',
      { audience: 'authenticated', summary: 'Revoke current or all sessions' },
      async (ctx, _b, _q, _req, res) => {
        res.clearCookie(cookieName, cookieOptions);
        return auth.logout(ctx, all);
      },
    );
  endpoint(
    app,
    'get',
    '/auth/me',
    { audience: 'authenticated', summary: 'Current user, permissions and project assignments' },
    async (ctx) => {
      const user = found(
        await db.user.findUnique({
          where: { id: ctx.actor.id },
          select: {
            id: true,
            name: true,
            email: true,
            accountType: true,
            projects: { select: { projectId: true } },
          },
        }),
      );
      return { ...user, permissions: [...ctx.actor.permissions] };
    },
  );
  endpoint(
    app,
    'post',
    '/auth/change-password',
    {
      audience: 'authenticated',
      summary: 'Change password and revoke all sessions',
      body: z.object({ currentPassword: z.string().max(128), newPassword: password }).strict(),
    },
    async (ctx, body) => auth.changePassword(ctx, body.currentPassword, body.newPassword),
  );
  endpoint(
    app,
    'post',
    '/auth/forgot-password',
    {
      public: true,
      audience: 'authenticated',
      summary: 'Request one-time password recovery email',
      body: z.object({ email: z.email().toLowerCase() }).strict(),
    },
    async (_ctx, body) => auth.forgotPassword(body.email),
  );
  endpoint(
    app,
    'post',
    '/auth/reset-password',
    {
      public: true,
      audience: 'authenticated',
      summary: 'Redeem a reset token and revoke sessions',
      body: z.object({ token: z.string().min(32).max(200), password }).strict(),
    },
    async (_ctx, body) => auth.resetPassword(body.token, body.password),
  );
  endpoint(
    app,
    'get',
    '/auth/sessions',
    { audience: 'authenticated', summary: 'List your device sessions' },
    async (ctx) =>
      db.session.findMany({
        where: { userId: ctx.actor.id },
        select: {
          id: true,
          platform: true,
          deviceId: true,
          createdAt: true,
          lastActivity: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
  );
  endpoint(
    app,
    'delete',
    '/auth/sessions/:id',
    { audience: 'authenticated', summary: 'Revoke one of your device sessions' },
    async (ctx, _b, _q, req) => {
      await db.session.updateMany({
        where: { id: req.params.id as string, userId: ctx.actor.id },
        data: { revokedAt: new Date() },
      });
      return { revoked: true };
    },
  );
  endpoint(
    app,
    'post',
    '/devices',
    {
      audience: 'authenticated',
      summary: 'Register authenticated push installation',
      body: z
        .object({
          installationId: z.string().min(8).max(100),
          platform: z.enum(['electron', 'android', 'ios']),
          pushToken: z.string().min(16).max(4096),
        })
        .strict(),
    },
    async (ctx, body) =>
      db.device.upsert({
        where: {
          userId_installationId: { userId: ctx.actor.id, installationId: body.installationId },
        },
        create: { ...body, userId: ctx.actor.id },
        update: body,
        select: { id: true, installationId: true, platform: true },
      }),
  );
  endpoint(
    app,
    'delete',
    '/devices/:id',
    { audience: 'authenticated', summary: 'Revoke push installation' },
    async (ctx, _b, _q, req) => {
      await db.device.deleteMany({
        where: { id: uuid.parse(req.params.id), userId: ctx.actor.id },
      });
      return { revoked: true };
    },
  );
}
