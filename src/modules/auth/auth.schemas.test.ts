import { describe, it, expect } from 'vitest';
import {
  registerSchema,
  loginSchema,
  inviteSchema,
  updateMemberRoleSchema,
  resetPasswordSchema,
} from './auth.schemas.js';

describe('registerSchema', () => {
  const valid = {
    email: 'koren@clickscales.com',
    password: 'a-perfectly-fine-passphrase',
    tenantName: 'ClickScales',
  };

  it('accepts a valid registration', () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects passwords under 12 characters', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'short1!' }).success).toBe(false);
  });

  it('accepts a long all-lowercase passphrase', () => {
    // The point of the NIST-style policy: length beats composition rules. A passphrase with no
    // digits or symbols must pass, or users end up at "Password1!".
    expect(
      registerSchema.safeParse({ ...valid, password: 'correct horse battery staple' }).success,
    ).toBe(true);
  });

  it('rejects a handful of known-terrible passwords', () => {
    for (const password of ['password1234', 'PASSWORD1234', '123456789012']) {
      expect(registerSchema.safeParse({ ...valid, password }).success).toBe(false);
    }
  });

  it('rejects a malformed email', () => {
    expect(registerSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });

  it('requires a workspace name', () => {
    expect(registerSchema.safeParse({ ...valid, tenantName: '' }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('does NOT apply the strength policy', () => {
    // Applying it here would lock out anyone whose password predates the rules, and would tell an
    // attacker the policy straight from the login form.
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'old' }).success).toBe(true);
  });

  it('still requires a non-empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('inviteSchema', () => {
  it('accepts admin, member and viewer', () => {
    for (const role of ['admin', 'member', 'viewer']) {
      expect(inviteSchema.safeParse({ email: 'a@b.com', role }).success).toBe(true);
    }
  });

  it('refuses to invite someone straight to owner', () => {
    // Ownership is transferred by an existing owner, never handed out by emailing a link.
    expect(inviteSchema.safeParse({ email: 'a@b.com', role: 'owner' }).success).toBe(false);
  });

  it('rejects an invented role', () => {
    expect(inviteSchema.safeParse({ email: 'a@b.com', role: 'superadmin' }).success).toBe(false);
  });
});

describe('updateMemberRoleSchema', () => {
  it('does allow owner — role CHANGES may grant ownership, invites may not', () => {
    expect(updateMemberRoleSchema.safeParse({ role: 'owner' }).success).toBe(true);
  });

  it('rejects an invented role', () => {
    expect(updateMemberRoleSchema.safeParse({ role: 'root' }).success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  it('enforces the strength policy on the NEW password', () => {
    const token = 'x'.repeat(43);
    expect(resetPasswordSchema.safeParse({ token, password: 'short' }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token, password: 'a-good-new-passphrase' }).success).toBe(true);
  });

  it('rejects an implausibly short token', () => {
    expect(resetPasswordSchema.safeParse({ token: 'abc', password: 'a-good-new-passphrase' }).success).toBe(false);
  });
});
