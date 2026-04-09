import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';

// 32-byte key in hex = 64 hex chars
const TEST_KEY = randomBytes(32).toString('hex');

describe('crypto', () => {
  it('encrypts and decrypts a string round-trip', () => {
    const plaintext = 'my-secret-api-key';
    const encrypted = encrypt(plaintext, TEST_KEY);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted, TEST_KEY)).toBe(plaintext);
  });

  it('produces iv:authTag:ciphertext format', () => {
    const encrypted = encrypt('hello', TEST_KEY);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    // IV = 16 bytes = 32 hex chars
    expect(parts[0]).toHaveLength(32);
    // Auth tag = 16 bytes = 32 hex chars
    expect(parts[1]).toHaveLength(32);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encrypt('same', TEST_KEY);
    const b = encrypt('same', TEST_KEY);
    expect(a).not.toBe(b);
    // Both still decrypt to the same value
    expect(decrypt(a, TEST_KEY)).toBe('same');
    expect(decrypt(b, TEST_KEY)).toBe('same');
  });

  it('fails to decrypt with wrong key', () => {
    const encrypted = encrypt('secret', TEST_KEY);
    const wrongKey = randomBytes(32).toString('hex');
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('handles empty string', () => {
    const encrypted = encrypt('', TEST_KEY);
    expect(decrypt(encrypted, TEST_KEY)).toBe('');
  });

  it('handles unicode', () => {
    const text = 'Cześć! 🚀 日本語';
    const encrypted = encrypt(text, TEST_KEY);
    expect(decrypt(encrypted, TEST_KEY)).toBe(text);
  });
});
