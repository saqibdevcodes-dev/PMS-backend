import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { db, transaction, lock, type Tx } from '../../database/client.js';
import { env } from '../../config/env.js';
import { AppError, found, requireState } from '../../common/errors.js';
import { hash, opaqueToken, encrypt } from '../../common/security.js';
import { audit, outbox } from '../../common/operations.js';
import type { Actor, Context } from '../../common/context.js';
import { throttle } from '../../integrations/redis.js';
import { emailUser, passwordChangedEmail, webLink } from '../../common/notifications.js';

export const passwordHash = (password: string) =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const authError = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials or unavailable account.');
async function issue(tx: Tx, session: { id: string; userId: string; expiresAt: Date }) {
  const token = opaqueToken();
  const expiresAt = new Date(
    Math.min(Date.now() + env.REFRESH_DAYS * 86400000, session.expiresAt.getTime()),
  );
  await tx.refreshToken.create({ data: { sessionId: session.id, hash: hash(token), expiresAt } });
  const accessToken = await new SignJWT({ sid: session.id })
    .setProtectedHeader({ alg: 'HS256', kid: env.JWT_ACTIVE_KID })
    .setSubject(session.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(env.JWT_KEYS[env.JWT_ACTIVE_KID]!));
  return {
    accessToken,
    refreshToken: token,
    expiresIn: 900,
    sessionId: session.id,
    refreshExpiresAt: expiresAt,
  };
}
export async function login(
  input: { email: string; password: string; deviceId?: string },
  platform: string,
  requestId: string,
  details: { ip?: string; userAgent?: string } = {},
) {
  if (!(await throttle(`login:${hash(input.email)}`, 15, 900)))
    throw new AppError(429, 'LOGIN_THROTTLED', 'Try again later.');
  const user = await db.user.findUnique({ where: { email: input.email } });
  // A real Argon2 verification is also performed for missing accounts to reduce timing enumeration.
  const dummy =
    '$argon2id$v=19$m=19456,t=2,p=1$MTIzNDU2Nzg5MGFiY2RlZg$8ZX5LGtoLSHRbnOxWHoIYMqgMbkUJAoWSXSWBHlpvmk';
  const valid = await argon2.verify(user?.passwordHash ?? dummy, input.password).catch(() => false);
  if (!user?.active || !valid) throw authError();
  return transaction(async (tx) => {
    await lock(tx, 'User', user.id);
    const current = found(await tx.user.findUnique({ where: { id: user.id } }));
    if (!current.active || current.passwordHash !== user.passwordHash) throw authError();
    if (!current.firstLoginAt)
      await tx.user.update({ where: { id: user.id }, data: { firstLoginAt: new Date() } });
    const session = await tx.session.create({
      data: {
        userId: user.id,
        platform,
        deviceId: input.deviceId,
        expiresAt: new Date(Date.now() + env.SESSION_DAYS * 86400000),
      },
    });
    await audit(
      tx,
      {
        actor: { id: user.id, sessionId: session.id, permissions: new Set() },
        projectId: '',
        requestId,
      },
      'auth.login',
      session.id,
    );
    await emailUser(
      tx,
      user.id,
      'New sign-in to your account',
      `Your account was signed in at ${session.createdAt.toISOString()} (UTC).\nPlatform: ${platform}${details.ip ? `\nIP address: ${details.ip}` : ''}${details.userAgent ? `\nBrowser or app: ${details.userAgent.slice(0, 500).replace(/[\r\n]/g, ' ')}` : ''}\n\nIf this was you, no action is needed. If you do not recognize this sign-in, reset your password and contact the property office: ${webLink('/forgot-password')}`,
    );
    return issue(tx, session);
  });
}
export async function refresh(token: string, native: boolean) {
  const result = await transaction(async (tx) => {
    const row = await tx.refreshToken.findUnique({ where: { hash: hash(token) } });
    if (!row) return null;
    await lock(tx, 'Session', row.sessionId);
    const session = found(
      await tx.session.findUnique({ where: { id: row.sessionId }, include: { user: true } }),
    );
    const current = found(await tx.refreshToken.findUnique({ where: { id: row.id } }));
    if (current.usedAt) {
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return 'replay' as const;
    }
    if (
      session.revokedAt ||
      !session.user.active ||
      session.expiresAt < new Date() ||
      current.expiresAt < new Date() ||
      (session.platform !== 'web') !== native
    )
      return null;
    await tx.refreshToken.update({ where: { id: current.id }, data: { usedAt: new Date() } });
    await tx.session.update({ where: { id: session.id }, data: { lastActivity: new Date() } });
    return issue(tx, session);
  });
  if (!result || result === 'replay')
    throw new AppError(
      401,
      result === 'replay' ? 'TOKEN_REPLAY' : 'SESSION_EXPIRED',
      'Please sign in again.',
    );
  return result;
}
export async function authenticate(token: string): Promise<Actor> {
  let payload;
  try {
    ({ payload } = await jwtVerify(
      token,
      (header) => {
        const key = header.kid ? env.JWT_KEYS[header.kid] : undefined;
        if (!key) throw new Error('Unknown signing key');
        return new TextEncoder().encode(key);
      },
      { algorithms: ['HS256'], issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
    ));
  } catch {
    throw new AppError(401, 'ACCESS_TOKEN_INVALID', 'The access token is invalid or expired.');
  }
  if (
    typeof payload.sid !== 'string' ||
    typeof payload.sub !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(payload.sid)
  )
    throw authError();
  const session = await db.session.findUnique({
    where: { id: payload.sid },
    include: {
      user: { include: { roles: { include: { role: { include: { permissions: true } } } } } },
    },
  });
  if (
    !session ||
    session.userId !== payload.sub ||
    session.revokedAt ||
    session.expiresAt < new Date() ||
    !session.user.active
  )
    throw new AppError(401, 'SESSION_REVOKED', 'The session is no longer active.');
  return {
    id: session.userId,
    sessionId: session.id,
    accountType: session.user.accountType,
    isSuperAdmin: session.user.roles.some((r) => r.role.name === 'Super Admin'),
    permissions: new Set(
      session.user.accountType === 'CUSTOMER'
        ? []
        : session.user.roles.flatMap((r) => r.role.permissions.map((p) => p.permissionKey)),
    ),
  };
}
export async function logout(ctx: Context, all = false) {
  return transaction(async (tx) => {
    await tx.session.updateMany({
      where: { userId: ctx.actor.id, ...(all ? {} : { id: ctx.actor.sessionId }), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit(tx, ctx, 'auth.logout', ctx.actor.id, { all });
    return { loggedOut: true };
  });
}
export async function changePassword(ctx: Context, oldPassword: string, newPassword: string) {
  const user = found(await db.user.findUnique({ where: { id: ctx.actor.id } }));
  requireState(
    await argon2.verify(user.passwordHash, oldPassword),
    'INVALID_CREDENTIALS',
    'The current password is incorrect.',
    401,
  );
  const nextHash = await passwordHash(newPassword);
  return transaction(async (tx) => {
    await lock(tx, 'User', user.id);
    const current = found(await tx.user.findUnique({ where: { id: user.id } }));
    requireState(
      current.passwordHash === user.passwordHash,
      'CREDENTIAL_CHANGED',
      'Credentials changed; sign in again.',
    );
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: nextHash, credentialsIssuedAt: null },
    });
    await tx.session.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    await audit(tx, ctx, 'auth.password_changed', user.id);
    await passwordChangedEmail(tx, user.id);
    return { changed: true };
  });
}
export async function forgotPassword(email: string) {
  const allowed = await throttle(`reset:${hash(email)}`, 3, 900);
  const user = await db.user.findUnique({ where: { email } });
  if (user?.active && allowed)
    await transaction(async (tx) => {
      const token = opaqueToken();
      await tx.passwordReset.create({
        data: { userId: user.id, hash: hash(token), expiresAt: new Date(Date.now() + 1800000) },
      });
      await outbox(tx, 'password-reset', { userId: user.id, encryptedToken: encrypt(token) });
    });
  return { message: 'If the account is eligible, password reset instructions will be sent.' };
}
export async function resetPassword(token: string, password: string) {
  const nextHash = await passwordHash(password);
  return transaction(async (tx) => {
    const reset = await tx.passwordReset.findUnique({ where: { hash: hash(token) } });
    requireState(
      reset && !reset.usedAt && reset.expiresAt > new Date(),
      'INVALID_RESET',
      'The reset token is invalid or expired.',
      400,
    );
    await lock(tx, 'User', reset.userId);
    const changed = await tx.passwordReset.updateMany({
      where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    requireState(
      changed.count === 1,
      'INVALID_RESET',
      'The reset token is invalid or expired.',
      400,
    );
    await tx.user.update({
      where: { id: reset.userId },
      data: { passwordHash: nextHash, credentialsIssuedAt: null },
    });
    await tx.passwordReset.updateMany({
      where: { userId: reset.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.session.updateMany({
      where: { userId: reset.userId },
      data: { revokedAt: new Date() },
    });
    await passwordChangedEmail(tx, reset.userId);
    return { changed: true };
  });
}
