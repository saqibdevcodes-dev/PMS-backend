import { db, transaction } from '../src/database/client.js';
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

  const passwordHashes = await Promise.all(
    accounts.map(async (account) => [account.email, await passwordHash(account.password)] as const),
  );
  const hashes = new Map(passwordHashes);

  await transaction(async (tx) => {
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

      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.userRole.deleteMany({ where: { userId: user.id } });

      if ('role' in account) {
        const role = await tx.role.findUniqueOrThrow({ where: { name: account.role } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      }
    }
  });

  console.log('Development accounts seeded.');
  for (const account of accounts)
    console.log(`${account.accountType}: ${account.email} (${account.name})`);
}

try {
  await seedDevelopmentAccounts();
} finally {
  await db.$disconnect();
  redis.disconnect();
}
