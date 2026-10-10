import 'dotenv/config';
import { z } from 'zod';
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  JWT_ACTIVE_KID: z.string().default('primary'),
  JWT_KEYS: z
    .string()
    .transform((v) => JSON.parse(v) as unknown)
    .pipe(z.record(z.string(), z.string().min(32))),
  JWT_ISSUER: z.string().default('pms'),
  JWT_AUDIENCE: z.string().default('pms-clients'),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  IDENTITY_HASH_KEY: z.string().min(32),
  TRUSTED_ORIGINS: z.string().transform((v) => v.split(',').map((s) => s.trim())),
  PUBLIC_WEB_URL: z.url(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  REFRESH_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: bool.default(false),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  PUBLIC_API_URL: z.url().optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(8).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_FROM: z.string().default('noreply@example.invalid'),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMS_WEBHOOK_URL: z.url().optional(),
  PUSH_WEBHOOK_URL: z.url().optional(),
  PROVIDER_TOKEN: z.string().optional(),
  MALWARE_SCAN_URL: z.url().optional(),
  MIN_CLIENT_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default('1.0.0'),
});
export const env = schema.parse(process.env);
if (
  env.STORAGE_DRIVER === 's3' &&
  (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)
)
  throw new Error('S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
if (
  env.STORAGE_DRIVER === 'local' &&
  env.PUBLIC_API_URL &&
  !['http:', 'https:'].includes(new URL(env.PUBLIC_API_URL).protocol)
)
  throw new Error('PUBLIC_API_URL must use HTTP or HTTPS');
if (
  env.STORAGE_DRIVER === 'local' &&
  env.NODE_ENV === 'production' &&
  !env.PUBLIC_API_URL?.startsWith('https://')
)
  throw new Error('Local storage in production requires an HTTPS PUBLIC_API_URL');
if (!env.JWT_KEYS[env.JWT_ACTIVE_KID]) throw new Error('JWT_ACTIVE_KID is absent from JWT_KEYS');
if (
  env.NODE_ENV === 'production' &&
  (!env.COOKIE_SECURE || !env.PUBLIC_WEB_URL.startsWith('https://'))
)
  throw new Error('Production requires HTTPS and secure cookies');
if (env.TRUSTED_ORIGINS.includes('*')) throw new Error('Wildcard origins are forbidden');
