import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { EventEmitter } from 'node:events';

// Runs the actual Prisma SQL against PostgreSQL WASM in memory. No sockets or server services.
export const embedded = new PGlite();
const pool = new pg.Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/test' });
type Query = {
  text: string;
  values?: unknown[];
  rowMode?: 'array';
  types?: { getTypeParser: (oid: number, format: string) => (value: string) => unknown };
};
const query = async (config: string | Query) => {
  const input = typeof config === 'string' ? { text: config } : config;
  const parsers = Object.fromEntries(
    Object.values(pg.types.builtins).map((oid) => [
      oid,
      input.types?.getTypeParser(oid, 'text') ?? pg.types.getTypeParser(oid),
    ]),
  );
  const result = await embedded.query(input.text, input.values, {
    rowMode: input.rowMode,
    parsers,
  });
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
pool.query = query as typeof pool.query;
pool.connect = (async () =>
  Object.assign(new EventEmitter(), { query, release() {} })) as typeof pool.connect;
export const testDb = new PrismaClient({ adapter: new PrismaPg(pool) });
export async function closeEmbedded() {
  await testDb.$disconnect();
  await pool.end();
  await embedded.close();
}
