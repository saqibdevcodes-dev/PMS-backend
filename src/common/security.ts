import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';
export const opaqueToken = () => randomBytes(48).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const identityHash = (value: string) =>
  createHmac('sha256', env.IDENTITY_HASH_KEY)
    .update(value.replace(/[^a-z0-9]/gi, '').toUpperCase())
    .digest('hex');
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(env.ENCRYPTION_KEY, 'hex'), iv);
  return Buffer.concat([
    iv,
    cipher.update(value, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}
export function decrypt(value: string) {
  const data = Buffer.from(value, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString(
    'utf8',
  );
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
