import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 15 }),
});
export type Tx = Prisma.TransactionClient;
export async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: 'Serializable', timeout: 20000 });
    } catch (e) {
      const adapterCause =
        e instanceof Prisma.PrismaClientKnownRequestError
          ? (
              e.meta?.driverAdapterError as
                { cause?: { kind?: string; originalCode?: string } } | undefined
            )?.cause
          : undefined;
      const retryable =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2034' ||
          adapterCause?.kind === 'TransactionWriteConflict' ||
          ['40001', '40P01'].includes(adapterCause?.originalCode ?? ''));
      if (retryable && attempt < 4) {
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
      } else throw e;
    }
  }
}
const lockTables = [
  'User',
  'Session',
  'Unit',
  'Booking',
  'Payment',
  'Approval',
  'AccountingPeriod',
  'Transfer',
  'Cancellation',
  'Refund',
  'Possession',
  'DealerCommission',
  'Project',
] as const;
export async function lock(tx: Tx, table: (typeof lockTables)[number], id: string) {
  if (!lockTables.includes(table)) throw new Error('Invalid lock target');
  // Table is a closed source-code allowlist; the identifier value remains parameterized.
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM ${Prisma.raw('"' + table + '"')} WHERE id = ${id}::uuid FOR UPDATE`,
  );
}
