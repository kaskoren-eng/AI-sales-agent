import { eq, and } from 'drizzle-orm';
import { authSessions, tenantMembers } from '../db/schema/index.js';
import type { Database } from '../db/client.js';
import type { TenantRole } from '../db/schema/index.js';
import { UnauthorizedError } from '../shared/errors.js';

/**
 * SESSION-BOUND ACCESS TOKENS — why a valid signature is not enough.
 *
 * A bearer JWT that is trusted purely because it verifies makes JWT_SECRET a master key: anyone
 * holding it can mint a token for any tenantId and walk in as that tenant. That is not a
 * hypothetical here — JWT_SECRET is present in four .env files in the working tree, one of which
 * is flagged in PROJECT_STATUS.md as having been exposed. Rotating the secret is necessary but
 * insufficient, because the same property returns the moment the next copy leaks.
 *
 * So a token is only accepted if it names a session row that actually exists, has not been
 * revoked, has not expired, and belongs to the tenant the token claims. Session rows are created
 * only by a successful login, so forging a token now requires database write access rather than
 * a leaked string. Revocation also becomes immediate rather than "wait for the token to expire".
 *
 * The role is read from tenant_members, NOT from the token's `rol` claim, so an attacker who
 * somehow obtains a session cannot escalate themselves to owner by editing a claim.
 */

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: TenantRole;
}

export interface SessionRow {
  id: string;
  userId: string;
  tenantId: string | null;
  revokedAt: Date | null;
  expiresAt: Date;
  role: TenantRole | null;
}

export async function loadSession(db: Database, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      tenantId: authSessions.tenantId,
      revokedAt: authSessions.revokedAt,
      expiresAt: authSessions.expiresAt,
      role: tenantMembers.role,
    })
    .from(authSessions)
    // LEFT JOIN, so that a session whose membership was revoked still resolves — and is then
    // rejected below with a clear reason, rather than looking like a missing session.
    .leftJoin(
      tenantMembers,
      and(
        eq(tenantMembers.tenantId, authSessions.tenantId),
        eq(tenantMembers.userId, authSessions.userId),
      ),
    )
    .where(eq(authSessions.id, sessionId))
    .limit(1);

  return row ?? null;
}

/**
 * Pure. Every rejection is the same 401 with the same message: an attacker probing session ids
 * must not learn whether one existed, was revoked, or merely expired.
 * `reason` is for the server log only.
 */
export function assertSessionUsable(
  session: SessionRow | null,
  claimedTenantId: string,
  now: Date = new Date(),
): { principal: SessionPrincipal } | { reason: string } {
  if (!session) return { reason: 'session_not_found' };
  if (session.revokedAt) return { reason: 'session_revoked' };
  if (session.expiresAt.getTime() <= now.getTime()) return { reason: 'session_expired' };
  // A session that has not yet chosen a tenant cannot authorise tenant-scoped work.
  if (!session.tenantId) return { reason: 'session_has_no_tenant' };
  // The decisive check: the token's tenant claim must match the session's own tenant. Without
  // this, a legitimate session for tenant A plus a forged claim for tenant B is a cross-tenant
  // takeover, and every other check above would pass.
  if (session.tenantId !== claimedTenantId) return { reason: 'session_tenant_mismatch' };
  if (!session.role) return { reason: 'membership_revoked' };

  return {
    principal: {
      sessionId: session.id,
      userId: session.userId,
      tenantId: session.tenantId,
      role: session.role,
    },
  };
}

export function sessionRejection(): UnauthorizedError {
  return new UnauthorizedError('Invalid credentials');
}
