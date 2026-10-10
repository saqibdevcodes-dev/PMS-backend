import { randomBytes } from 'node:crypto';

// These tests must run without a local .env or any infrastructure connection.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/pms_unit_test',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_KEYS: JSON.stringify({ primary: randomBytes(48).toString('hex') }),
  JWT_ACTIVE_KID: 'primary',
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  IDENTITY_HASH_KEY: randomBytes(48).toString('hex'),
  TRUSTED_ORIGINS: 'http://localhost:3000',
  PUBLIC_WEB_URL: 'http://localhost:3000',
  COOKIE_SECURE: 'false',
  STORAGE_DRIVER: 'local',
  UPLOAD_DIR: '.runtime/unit-uploads',
  PUBLIC_API_URL: 'http://localhost:4000',
});
// Local storage must work without any object-store configuration.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('S3_')) delete process.env[name];
}
