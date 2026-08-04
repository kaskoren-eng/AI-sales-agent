import { describe, it, expect } from 'vitest';
import { assertSessionUsable, type SessionRow } from './auth-session.js';

const NOW = new Date('2026-08-05T00:00:00Z');
const FUTURE = new Date('2026-09-05T00:00:00Z');
const PAST = new Date('2026-07-05T00:00:00Z');

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    revokedAt: null,
    expiresAt: FUTURE,
    role: 'member',
    ...over,
  };
}

describe('assertSessionUsable', () => {
  it('accepts a live session for the claimed tenant', () => {
    const r = assertSessionUsable(session(), 'tenant-1', NOW);
    expect(r).toEqual({
      principal: { sessionId: 'sess-1', userId: 'user-1', tenantId: 'tenant-1', role: 'member' },
    });
  });

  it('rejects a session id that does not exist', () => {
    // THE ONE THAT MATTERS: this is what a forged token carries. Someone holding a leaked
    // JWT_SECRET can sign anything they like, but they cannot invent a session row, so the
    // token resolves to nothing and is refused.
    expect(assertSessionUsable(null, 'tenant-1', NOW)).toEqual({ reason: 'session_not_found' });
  });

  it('rejects a revoked session', () => {
    expect(assertSessionUsable(session({ revokedAt: PAST }), 'tenant-1', NOW))
      .toEqual({ reason: 'session_revoked' });
  });

  it('rejects an expired session', () => {
    expect(assertSessionUsable(session({ expiresAt: PAST }), 'tenant-1', NOW))
      .toEqual({ reason: 'session_expired' });
  });

  it('treats expiry as inclusive — a session expiring exactly now is dead', () => {
    expect(assertSessionUsable(session({ expiresAt: NOW }), 'tenant-1', NOW))
      .toEqual({ reason: 'session_expired' });
  });

  it('rejects a cross-tenant claim on an otherwise valid session', () => {
    // A real session for tenant-1 plus a forged `tenantId: tenant-2` claim. Every other check
    // passes; only this one stands between a legitimate low-privilege user and someone else's
    // data. Without it, session binding would close the forgery hole and leave a takeover.
    expect(assertSessionUsable(session({ tenantId: 'tenant-1' }), 'tenant-2', NOW))
      .toEqual({ reason: 'session_tenant_mismatch' });
  });

  it('rejects a session whose tenant was never chosen', () => {
    expect(assertSessionUsable(session({ tenantId: null }), 'tenant-1', NOW))
      .toEqual({ reason: 'session_has_no_tenant' });
  });

  it('rejects a session whose membership was revoked', () => {
    // Removing someone from a tenant must lock them out immediately, not when their access
    // token happens to expire.
    expect(assertSessionUsable(session({ role: null }), 'tenant-1', NOW))
      .toEqual({ reason: 'membership_revoked' });
  });

  it('returns the role from the session row, not from any caller-supplied value', () => {
    const r = assertSessionUsable(session({ role: 'viewer' }), 'tenant-1', NOW);
    expect('principal' in r && r.principal.role).toBe('viewer');
  });
});
