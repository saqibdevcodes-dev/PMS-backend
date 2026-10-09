import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';

vi.mock('../src/database/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/database/client.js')>();
  const { testDb } = await import('./embedded-postgres.js');
  return {
    ...original,
    db: testDb,
    transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      testDb.$transaction(work, { timeout: 20000 }),
  };
});
import { embedded, testDb as db, closeEmbedded } from './embedded-postgres.js';
import { adminStatus, recoverAdminPassword } from '../src/modules/auth/admin-recovery.js';
import { passwordHash } from '../src/modules/auth/service.js';

const email = 'recovery-admin@example.invalid';
const originalPassword = 'Original-Password-123';
const nextPassword = 'Replacement-Password-456';
let adminId: string;
let originalHash: string;
beforeAll(async () => {
  for (const folder of (await readdir('prisma/migrations')).filter((f) => /^\d/.test(f)).sort())
    await embedded.exec(await readFile(`prisma/migrations/${folder}/migration.sql`, 'utf8'));
  originalHash = await passwordHash(originalPassword);
  const role = await db.role.create({ data: { name: 'Super Admin' } });
  const admin = await db.user.create({
    data: {
      email,
      name: 'Recovery admin',
      passwordHash: originalHash,
      roles: { create: { roleId: role.id } },
    },
  });
  adminId = admin.id;
  await db.user.createMany({
    data: [
      { email: 'staff@example.invalid', name: 'Ordinary staff', passwordHash: originalHash },
      {
        email: 'customer@example.invalid',
        name: 'Customer',
        passwordHash: originalHash,
        accountType: 'CUSTOMER',
      },
    ],
  });
}, 60000);
afterAll(async () => closeEmbedded());

describe('operator administrator recovery', () => {
  it('reports status without exposing credentials or changing the account', async () => {
    expect(await adminStatus('missing@example.invalid')).toEqual({ exists: false });
    const status = await adminStatus(email.toUpperCase(), originalPassword);
    expect(status).toEqual({
      exists: true,
      active: true,
      accountType: 'STAFF',
      superAdmin: true,
      configuredPasswordMatches: true,
    });
    expect((await adminStatus(email, nextPassword)).configuredPasswordMatches).toBe(false);
    expect(JSON.stringify(status)).not.toContain(originalPassword);
    expect(JSON.stringify(status)).not.toContain(originalHash);
    expect((await db.user.findUniqueOrThrow({ where: { id: adminId } })).passwordHash).toBe(
      originalHash,
    );
  });
  it('resets only the selected administrator and revokes sessions and reset tokens', async () => {
    const session = await db.session.create({
      data: { userId: adminId, platform: 'web', expiresAt: new Date(Date.now() + 3600000) },
    });
    const reset = await db.passwordReset.create({
      data: {
        userId: adminId,
        hash: 'test-only-reset-hash',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await recoverAdminPassword(email, nextPassword);
    expect((await adminStatus(email, nextPassword)).configuredPasswordMatches).toBe(true);
    expect((await adminStatus(email, originalPassword)).configuredPasswordMatches).toBe(false);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt,
    ).not.toBeNull();
    expect(
      (await db.passwordReset.findUniqueOrThrow({ where: { id: reset.id } })).usedAt,
    ).not.toBeNull();
    expect(
      (await db.user.findUniqueOrThrow({ where: { email: 'staff@example.invalid' } })).passwordHash,
    ).toBe(originalHash);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: 'auth.admin_password_recovered' },
    });
    expect(audit.entityId).toBe(adminId);
    expect(audit.data).toEqual({ source: 'operator-cli' });
  });
  it('rejects missing accounts and weak passwords', async () => {
    await expect(
      recoverAdminPassword('missing@example.invalid', nextPassword),
    ).rejects.toMatchObject({ code: 'ADMIN_NOT_FOUND' });
    await expect(recoverAdminPassword(email, 'short')).rejects.toHaveProperty('name', 'ZodError');
    expect((await adminStatus(email, nextPassword)).configuredPasswordMatches).toBe(true);
  });
  it('does not promote staff or reset customer credentials even with an accidental admin role', async () => {
    const role = await db.role.findUniqueOrThrow({ where: { name: 'Super Admin' } });
    const customer = await db.user.findUniqueOrThrow({
      where: { email: 'customer@example.invalid' },
    });
    await db.userRole.create({ data: { userId: customer.id, roleId: role.id } });
    for (const target of ['staff@example.invalid', 'customer@example.invalid']) {
      await expect(recoverAdminPassword(target, nextPassword)).rejects.toMatchObject({
        code: 'ADMIN_ROLE_REQUIRED',
      });
      expect((await adminStatus(target, originalPassword)).configuredPasswordMatches).toBe(true);
    }
  });
  it('preserves disabled-account status and credentials', async () => {
    await db.user.update({ where: { id: adminId }, data: { active: false } });
    await expect(recoverAdminPassword(email, originalPassword)).rejects.toMatchObject({
      code: 'ADMIN_INACTIVE',
    });
    expect(await adminStatus(email, nextPassword)).toMatchObject({
      active: false,
      configuredPasswordMatches: true,
    });
  });
});
