import { z } from 'zod';
import { env } from '../src/config/env.js';
import { db } from '../src/database/client.js';
import { redis } from '../src/integrations/redis.js';
import { AppError } from '../src/common/errors.js';
import { adminStatus, recoverAdminPassword } from '../src/modules/auth/admin-recovery.js';

try {
  const mode = process.argv[2];
  if (!['status', 'reset-password'].includes(mode ?? '') || process.argv.length !== 3)
    throw new Error(
      'Use npm run admin:status or npm run admin:reset-password. Configure credentials in the backend environment, not command-line arguments.',
    );
  const email = z.email().parse(process.env.ADMIN_EMAIL).toLowerCase();
  const target = new URL(env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || '5432'}${target.pathname}`);
  console.log(`Account: ${email}`);
  if (mode === 'status') {
    console.log(JSON.stringify(await adminStatus(email, process.env.ADMIN_PASSWORD), null, 2));
  } else {
    await recoverAdminPassword(email, process.env.ADMIN_PASSWORD ?? '');
    console.log(
      'Administrator password reset to ADMIN_PASSWORD. Existing sessions and unused reset tokens revoked.',
    );
  }
} catch (error) {
  if (error instanceof z.ZodError)
    console.error(
      'Set a valid ADMIN_EMAIL and, for reset, ADMIN_PASSWORD with 12–128 characters, uppercase, lowercase and a number.',
    );
  else if (error instanceof AppError) console.error(`${error.code}: ${error.message}`);
  else
    console.error(
      'Administrator operation failed. Check the command, backend environment, database connection and deployed migrations.',
    );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
  redis.disconnect();
}
