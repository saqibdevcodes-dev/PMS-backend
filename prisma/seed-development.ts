import { db, transaction } from '../src/database/client.js';
import { permissions, roleMatrix } from '../src/common/permissions.js';
import { encrypt, identityHash } from '../src/common/security.js';
import { passwordHash } from '../src/modules/auth/service.js';
import { redis } from '../src/integrations/redis.js';
import { env } from '../src/config/env.js';

const accounts = [
  {
    email: 'binishaqtrader@gmail.com',
    password: 'Binishaqtrader@123',
    name: 'Bin Ishaq Trader',
    accountType: 'STAFF' as const,
    role: 'Super Admin',
  },
  {
    email: 'admin.test@example.com',
    password: 'TestAccount@123',
    name: 'Test Administrator',
    accountType: 'STAFF' as const,
    role: 'Super Admin',
  },
  {
    email: 'sales.test@example.com',
    password: 'TestAccount@123',
    name: 'Test Sales Executive',
    accountType: 'STAFF' as const,
    role: 'Sales Executive',
  },
  {
    email: 'customer.test@example.com',
    password: 'TestAccount@123',
    name: 'Test Customer',
    accountType: 'CUSTOMER' as const,
  },
] as const;

async function seedRoles() {
  await transaction(async (tx) => {
    for (const key of permissions)
      await tx.permission.upsert({ where: { key }, create: { key }, update: {} });

    for (const [name, grants] of Object.entries(roleMatrix)) {
      const role = await tx.role.upsert({ where: { name }, create: { name }, update: {} });
      if ((await tx.rolePermission.count({ where: { roleId: role.id } })) === 0)
        await tx.rolePermission.createMany({
          data: grants.map((permissionKey) => ({ roleId: role.id, permissionKey })),
        });
    }
  });
}

async function seedDevelopmentAccounts() {
  if (
    env.NODE_ENV === 'production' &&
    process.env.ALLOW_PRODUCTION_DEVELOPMENT_SEED !== 'I_UNDERSTAND'
  )
    throw new Error(
      'Development accounts cannot be seeded in production without the explicit ' +
        'ALLOW_PRODUCTION_DEVELOPMENT_SEED=I_UNDERSTAND opt-in.',
    );

  if (env.NODE_ENV === 'production')
    console.warn(
      'WARNING: creating deterministic development accounts in the production database.',
    );

  await seedRoles();

  const passwordHashes = await Promise.all(
    accounts.map(async (account) => [account.email, await passwordHash(account.password)] as const),
  );
  const hashes = new Map(passwordHashes);

  await transaction(async (tx) => {
    const company = await tx.company.upsert({
      where: { code: 'DEV-SEED-COMPANY' },
      create: { code: 'DEV-SEED-COMPANY', name: 'Development Seed Company' },
      update: {},
    });
    const project = await tx.project.upsert({
      where: { code: 'DEV-SEED-PROJECT' },
      create: {
        code: 'DEV-SEED-PROJECT',
        name: 'Development Seed Project',
        companyId: company.id,
      },
      update: {},
    });

    const users = new Map<string, string>();
    for (const account of accounts) {
      const user = await tx.user.upsert({
        where: { email: account.email },
        create: {
          email: account.email,
          name: account.name,
          passwordHash: hashes.get(account.email)!,
          accountType: account.accountType,
          active: true,
        },
        update: {
          name: account.name,
          passwordHash: hashes.get(account.email)!,
          accountType: account.accountType,
          active: true,
        },
      });
      users.set(account.email, user.id);

      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.userRole.deleteMany({ where: { userId: user.id } });

      if ('role' in account) {
        const role = await tx.role.findUniqueOrThrow({ where: { name: account.role } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
        await tx.companyMember.upsert({
          where: { companyId_userId: { companyId: company.id, userId: user.id } },
          create: {
            companyId: company.id,
            userId: user.id,
            role: account.role === 'Super Admin' ? 'OWNER' : 'MEMBER',
          },
          update: { role: account.role === 'Super Admin' ? 'OWNER' : 'MEMBER' },
        });
        await tx.userProjectAccess.upsert({
          where: { userId_projectId: { userId: user.id, projectId: project.id } },
          create: { userId: user.id, projectId: project.id },
          update: {},
        });
      }
    }

    const customerEmail = 'customer.test@example.com';
    const testIdentity = 'DEV-SEED-CUSTOMER-0001';
    await tx.customer.upsert({
      where: { reference: 'DEV-SEED-CUSTOMER-001' },
      create: {
        reference: 'DEV-SEED-CUSTOMER-001',
        projectId: project.id,
        portalUserId: users.get(customerEmail)!,
        name: 'Test Customer',
        phone: '+92 300 0000000',
        email: customerEmail,
        address: 'Test address',
        identityEncrypted: encrypt(testIdentity),
        identityHash: identityHash(testIdentity),
        identityLast4: '0001',
        communicationConsent: true,
      },
      update: {
        portalUserId: users.get(customerEmail)!,
        email: customerEmail,
      },
    });
  });

  console.log('Development accounts and demo project seeded.');
  for (const account of accounts)
    console.log(`${account.accountType}: ${account.email} (${account.name})`);
}

try {
  await seedDevelopmentAccounts();
} finally {
  await db.$disconnect();
  redis.disconnect();
}
