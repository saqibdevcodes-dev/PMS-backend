import { describe, it, expect } from 'vitest';
import {
  canonical,
  decrypt,
  encrypt,
  hash,
  identityHash,
  opaqueToken,
} from '../src/common/security.js';

describe('private identity protection', () => {
  it('round-trips Unicode using different ciphertext for repeated plaintext', () => {
    const identity = 'Customer identity — شناخت 12345';
    const first = encrypt(identity);
    const second = encrypt(identity);
    expect(first).not.toBe(second);
    expect(decrypt(first)).toBe(identity);
    expect(decrypt(second)).toBe(identity);
    expect(Buffer.from(first, 'base64').includes(Buffer.from(identity))).toBe(false);
  });

  it.each([0, 12, -1])('rejects modification at encrypted byte %i', (offset) => {
    const bytes = Buffer.from(encrypt('Private identity'), 'base64');
    const index = offset < 0 ? bytes.length + offset : offset;
    bytes[index] = bytes[index]! ^ 1;
    expect(() => decrypt(bytes.toString('base64'))).toThrow();
  });

  it('rejects truncated encrypted values', () => {
    expect(() => decrypt('')).toThrow();
    expect(() => decrypt(Buffer.alloc(16).toString('base64'))).toThrow();
  });

  it('matches formatting variants without storing a plain identity digest', () => {
    expect(identityHash('ab-123 456')).toBe(identityHash('AB123456'));
    expect(identityHash('AB123456')).not.toBe(identityHash('AB123457'));
    expect(identityHash('AB123456')).not.toBe(hash('AB123456'));
  });
});

describe('tokens and idempotency fingerprints', () => {
  it('produces URL-safe tokens with 48 random bytes', () => {
    const tokens = Array.from({ length: 64 }, opaqueToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(48);
      expect(hash(token)).not.toBe(token);
    }
  });

  it('ignores object key order but preserves array order, values and JSON types', () => {
    const value = { amount: '10.00', details: { b: 2, a: ['x', 'y'] } };
    expect(canonical(value)).toBe(canonical({ details: { a: ['x', 'y'], b: 2 }, amount: '10.00' }));
    expect(canonical(value)).not.toBe(canonical({ ...value, amount: '11.00' }));
    expect(canonical(['x', 'y'])).not.toBe(canonical(['y', 'x']));
    expect(canonical('10')).not.toBe(canonical(10));
    expect(canonical(null)).not.toBe(canonical('null'));
  });
});
