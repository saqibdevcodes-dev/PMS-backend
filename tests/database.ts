import 'dotenv/config';
import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  if (!process.env.TEST_DATABASE_URL) url.pathname = '/pms_test';
  const name = url.pathname.slice(1);
  if (!/^[a-z][a-z0-9_]*_test$/.test(name)) throw new Error('Unsafe test database name');
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const client = new Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`);
  await client.end();
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
    timeout: 60000,
  });
  const test = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await test.connect();
  const tables = await test.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'",
  );
  if (tables.rows.length)
    await test.query(
      'TRUNCATE ' +
        tables.rows.map((t) => '"' + t.tablename.replaceAll('"', '""') + '"').join(',') +
        ' CASCADE',
    );
  await test.end();
}
