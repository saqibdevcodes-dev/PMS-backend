import { z } from 'zod';
import { db, transaction } from '../src/database/client.js';
import { permissions, roleMatrix } from '../src/common/permissions.js';
import { password } from '../src/common/http.js';
import { passwordHash } from '../src/modules/auth/service.js';
import { redis } from '../src/integrations/redis.js';
import { welcomeUser } from '../src/common/notifications.js';
export async function seedRoles() {
  return transaction(async (tx) => {
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
await seedRoles();
if (process.env.ADMIN_EMAIL || process.env.ADMIN_PASSWORD) {
  const email = z.email().toLowerCase().parse(process.env.ADMIN_EMAIL);
  const pass = password.parse(process.env.ADMIN_PASSWORD);
  if (!(await db.user.findUnique({ where: { email } }))) {
    const role = await db.role.findUniqueOrThrow({ where: { name: 'Super Admin' } });
    const nextHash = await passwordHash(pass);
    await transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: 'Administrator',
          passwordHash: nextHash,
          roles: { create: { roleId: role.id } },
        },
      });
      await welcomeUser(tx, user.id);
    });
    console.log('Administrator created from environment credentials.');
  } else console.log('Administrator already exists; password unchanged.');
} else
  console.log(
    'Roles seeded. Set ADMIN_EMAIL and ADMIN_PASSWORD to bootstrap the first administrator.',
  );
await db.$disconnect();
redis.disconnect();
