import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { db, lock, transaction } from '../../database/client.js';
import { password } from '../../common/http.js';
import { requireState } from '../../common/errors.js';
import { audit } from '../../common/operations.js';
import { passwordHash } from './service.js';
import { passwordChangedEmail } from '../../common/notifications.js';

const emailSchema = z.email().trim().toLowerCase();

// Operator-only functions called by the local CLI. Never register them as public API routes.
export async function adminStatus(email: string, configuredPassword?: string) {
  const user = await db.user.findUnique({
    where: { email: emailSchema.parse(email) },
    include: { roles: { include: { role: true } } },
  });
  if (!user) return { exists: false };
  return {
    exists: true,
    active: user.active,
    accountType: user.accountType,
    superAdmin: user.roles.some(({ role }) => role.name === 'Super Admin'),
    configuredPasswordMatches: configuredPassword
      ? await argon2.verify(user.passwordHash, configuredPassword).catch(() => false)
      : null,
  };
}

export async function recoverAdminPassword(email: string, nextPassword: string) {
  const normalizedEmail = emailSchema.parse(email);
  const nextHash = await passwordHash(password.parse(nextPassword));
  return transaction(async (tx) => {
    const candidate = await tx.user.findUnique({ where: { email: normalizedEmail } });
    requireState(
      candidate,
      'ADMIN_NOT_FOUND',
      'No account found. Run db:seed on this database first.',
      404,
    );
    await lock(tx, 'User', candidate.id);
    const user = await tx.user.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { roles: { include: { role: true } } },
    });
    requireState(
      user.accountType === 'STAFF' && user.roles.some(({ role }) => role.name === 'Super Admin'),
      'ADMIN_ROLE_REQUIRED',
      'This command only resets an existing staff Super Admin. It does not assign roles.',
      403,
    );
    requireState(
      user.active,
      'ADMIN_INACTIVE',
      'This account is disabled. An authorized administrator must enable it first.',
      403,
    );
    const now = new Date();
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: nextHash } });
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await audit(
      tx,
      {
        actor: { id: user.id, sessionId: '', accountType: 'STAFF', permissions: new Set() },
        projectId: '',
        requestId: randomUUID(),
      },
      'auth.admin_password_recovered',
      user.id,
      { source: 'operator-cli' },
    );
    await passwordChangedEmail(tx, user.id);
    return { changed: true };
  });
}
