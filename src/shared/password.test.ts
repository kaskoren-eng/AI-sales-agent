import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, generateToken, hashToken } from './crypto.js';

describe('hashPassword / verifyPassword', () => {
  it('accepts the correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('never stores the plaintext', async () => {
    const stored = await hashPassword('hunter2');
    expect(stored).not.toContain('hunter2');
  });

  it('salts — the same password hashes differently every time', async () => {
    // Without a per-password salt, identical passwords produce identical hashes and a single
    // rainbow table breaks every account at once.
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('uses the documented salt:hash format', async () => {
    const [salt, hash] = (await hashPassword('x')).split(':');
    expect(salt).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(hash).toMatch(/^[0-9a-f]{128}$/); // 64 bytes
  });

  it('returns false — never throws — for a NULL stored hash', async () => {
    // An invited user who has not accepted yet has password_hash = NULL. That is a normal state,
    // and it must be indistinguishable from a wrong password rather than a 500.
    expect(await verifyPassword('anything', null)).toBe(false);
  });

  it('returns false — never throws — for a malformed stored hash', async () => {
    for (const bad of ['', 'nocolon', ':', 'zz:zz', 'abcd:', ':abcd', 'deadbeef:short']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('handles unicode and long passphrases', async () => {
    const pw = 'סיסמה־בעברית 🔐 ' + 'x'.repeat(300);
    const stored = await hashPassword(pw);
    expect(await verifyPassword(pw, stored)).toBe(true);
    expect(await verifyPassword(pw + 'y', stored)).toBe(false);
  });

  it('does not accept a truncated password (whole input is hashed)', async () => {
    // bcrypt silently truncates at 72 bytes; scrypt does not. Pin the difference so a future
    // swap to a truncating algorithm cannot pass unnoticed.
    const base = 'y'.repeat(72);
    const stored = await hashPassword(base + 'DIFFERENT');
    expect(await verifyPassword(base + 'different', stored)).toBe(false);
    expect(await verifyPassword(base, stored)).toBe(false);
  });
});

describe('generateToken / hashToken', () => {
  it('returns a token whose hash matches hashToken', () => {
    const { token, hash } = generateToken();
    expect(hashToken(token)).toBe(hash);
  });

  it('produces URL-safe tokens (they travel in emails and cookies)', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces a 64-hex-char sha256, matching the varchar(64) columns', () => {
    // auth_sessions.refresh_token_hash, invites.token_hash and auth_tokens.token_hash are all
    // varchar(64). A longer digest would be silently truncated by Postgres and break lookups.
    expect(generateToken().hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateToken().token);
    expect(seen.size).toBe(1000);
  });

  it('carries at least 256 bits of entropy', () => {
    // 32 random bytes base64url-encoded is 43 chars. Anything shorter means someone shrank the
    // token and made session/invite guessing feasible.
    expect(generateToken().token.length).toBeGreaterThanOrEqual(43);
  });
});
