import 'dotenv/config';
import { randomBytes } from 'node:crypto';
process.env.NODE_ENV = 'test';
const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!process.env.TEST_DATABASE_URL) url.pathname = '/pms_test';
if (!url.pathname.endsWith('_test'))
  throw new Error('Tests require an isolated database whose name ends in _test');
process.env.DATABASE_URL = url.toString();
process.env.JWT_KEYS = JSON.stringify({ primary: randomBytes(48).toString('hex') });
process.env.JWT_ACTIVE_KID = 'primary';
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
process.env.IDENTITY_HASH_KEY ??= randomBytes(48).toString('hex');
process.env.COOKIE_SECURE = 'false';
process.env.TRUSTED_ORIGINS = 'http://localhost:3000,capacitor://localhost';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
