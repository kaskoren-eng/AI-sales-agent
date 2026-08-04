import { and, eq, isNull, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  users,
  tenantMembers,
  authSessions,
  authTokens,
  invites,
  tenants,
} from '../../db/schema/index.js';
import type { TenantRole } from '../../db/schema/index.js';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
} from '../../shared/crypto.js';
import {
  UnauthorizedError,
  ValidationError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
} from '../../shared/errors.js';

/**
 * Access tokens are short because they cannot be revoked directly — revocation works by killing
 * the session they point at, which the auth plugin checks on every request. 15 minutes bounds
 * how long a stolen access token survives if that check is ever bypassed.
 */
export const ACCESS_TOKEN_TTL = '15m';
const SESSION_TTL_DAYS = 30;
const RESET_TTL_MINUTES = 60;
const INVITE_TTL_DAYS = 7;

/** Lockout thresholds. Generous enough not to annoy a real user who mistypes. */
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;

export interface AccessClaims {
  tenantId: string;
  sub: string;
  sid: string;
  rol: TenantRole;
}

export interface LoginResult {
  claims: AccessClaims;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: { id: string; email: string; name: string | null; locale: string };
  tenant: { id: string; name: string; slug: string; role: TenantRole };
}

export interface MembershipSummary {
  tenantId: string;
  name: string;
  slug: string;
  role: TenantRole;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export class AuthService {
  constructor(private db: Database) {}

  // ── Registration ──────────────────────────────────────────────────────────────────────────

  /**
   * Creates a user AND their tenant, making them its owner. This is the only path that mints a
   * tenant outside the operator console, and it deliberately does NOT let the caller choose an
   * existing tenant — joining an existing tenant happens through an invite.
   */
  async register(input: {
    email: string;
    password: string;
    name?: string;
    tenantName: string;
    locale?: string;
  }): Promise<{ userId: string; tenantId: string }> {
    const email = normalizeEmail(input.email);

    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) throw new ConflictError('An account with that email already exists');

    const passwordHash = await hashPassword(input.password);
    const slug = await this.uniqueSlug(input.tenantName);

    // One transaction: a user without a tenant, or a tenant without an owner, are both broken
    // states that nothing else in the system knows how to repair.
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: input.tenantName, slug })
        .returning({ id: tenants.id });

      const [user] = await tx
        .insert(users)
        .values({ email, passwordHash, name: input.name ?? null, locale: input.locale ?? 'he' })
        .returning({ id: users.id });

      await tx.insert(tenantMembers).values({
        tenantId: tenant!.id,
        userId: user!.id,
        role: 'owner',
      });

      return { userId: user!.id, tenantId: tenant!.id };
    });
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'tenant';

    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const [taken] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, candidate))
        .limit(1);
      if (!taken) return candidate;
    }
    // Deterministic attempts exhausted — fall back to something that cannot collide.
    return `${base}-${generateToken().token.slice(0, 8).toLowerCase()}`;
  }

  // ── Login ─────────────────────────────────────────────────────────────────────────────────

  async login(input: {
    email: string;
    password: string;
    ip?: string;
    userAgent?: string;
  }): Promise<LoginResult> {
    const email = normalizeEmail(input.email);

    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        locale: users.locale,
        passwordHash: users.passwordHash,
        failedLoginCount: users.failedLoginCount,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Same error for "no such user" and "wrong password" — otherwise the login form doubles as
    // a way to enumerate which email addresses have accounts.
    const invalid = () => new UnauthorizedError('Invalid email or password');

    if (!user) {
      // Spend comparable time on a nonexistent user so response timing does not leak existence.
      await verifyPassword(input.password, `${'0'.repeat(32)}:${'0'.repeat(128)}`);
      throw invalid();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenError('Account temporarily locked. Try again later.');
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await this.recordFailedLogin(user.id, user.failedLoginCount);
      throw invalid();
    }

    const memberships = await this.listMemberships(user.id);
    if (memberships.length === 0) {
      // A user with no tenant has nothing to act on. Happens if their last membership was
      // revoked; treat it as a failed login rather than issuing a session that can do nothing.
      throw new ForbiddenError('This account is not a member of any workspace');
    }

    await this.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const membership = memberships[0]!;
    const session = await this.createSession({
      userId: user.id,
      tenantId: membership.tenantId,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return {
      claims: { tenantId: membership.tenantId, sub: user.id, sid: session.id, rol: membership.role },
      refreshToken: session.token,
      refreshExpiresAt: session.expiresAt,
      user: { id: user.id, email: user.email, name: user.name, locale: user.locale },
      tenant: {
        id: membership.tenantId,
        name: membership.name,
        slug: membership.slug,
        role: membership.role,
      },
    };
  }

  private async recordFailedLogin(userId: string, current: number): Promise<void> {
    const next = current + 1;
    await this.db
      .update(users)
      .set({
        failedLoginCount: next,
        lockedUntil: next >= MAX_FAILED_LOGINS
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const rows = await this.db
      .select({
        tenantId: tenantMembers.tenantId,
        role: tenantMembers.role,
        name: tenants.name,
        slug: tenants.slug,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
      // A suspended tenant must not appear in the switcher — otherwise the user picks it and
      // every subsequent request 403s with no explanation.
      .where(and(eq(tenantMembers.userId, userId), eq(tenants.isActive, true)))
      .orderBy(tenants.name);

    return rows.map((r) => ({
      tenantId: r.tenantId,
      role: r.role,
      name: r.name,
      slug: r.slug,
    }));
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────────────────

  private async createSession(input: {
    userId: string;
    tenantId: string;
    ip?: string;
    userAgent?: string;
    parentId?: string;
  }): Promise<{ id: string; token: string; expiresAt: Date }> {
    const { token, hash } = generateToken();
    const expiresAt = daysFromNow(SESSION_TTL_DAYS);

    const [row] = await this.db
      .insert(authSessions)
      .values({
        userId: input.userId,
        tenantId: input.tenantId,
        refreshTokenHash: hash,
        parentId: input.parentId ?? null,
        ip: input.ip?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 255) ?? null,
        expiresAt,
      })
      .returning({ id: authSessions.id });

    return { id: row!.id, token, expiresAt };
  }

  /**
   * Refresh with rotation and reuse detection.
   *
   * Presenting an already-rotated token means someone kept a copy — the legitimate client would
   * have discarded it. There is no way to tell which party is the attacker, so the entire chain
   * is revoked and both are forced to log in again. Losing a session beats leaving a live one in
   * an attacker's hands.
   */
  async refresh(input: {
    refreshToken: string;
    ip?: string;
    userAgent?: string;
  }): Promise<LoginResult> {
    const hash = hashToken(input.refreshToken);

    const [session] = await this.db
      .select({
        id: authSessions.id,
        userId: authSessions.userId,
        tenantId: authSessions.tenantId,
        revokedAt: authSessions.revokedAt,
        expiresAt: authSessions.expiresAt,
      })
      .from(authSessions)
      .where(eq(authSessions.refreshTokenHash, hash))
      .limit(1);

    const invalid = () => new UnauthorizedError('Invalid or expired session');
    if (!session) throw invalid();

    if (session.revokedAt) {
      // REUSE DETECTED.
      await this.revokeChain(session.id);
      throw invalid();
    }
    if (session.expiresAt.getTime() <= Date.now()) throw invalid();
    if (!session.tenantId) throw invalid();

    const [membership] = await this.db
      .select({
        role: tenantMembers.role,
        name: tenants.name,
        slug: tenants.slug,
        isActive: tenants.isActive,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
      .where(
        and(
          eq(tenantMembers.userId, session.userId),
          eq(tenantMembers.tenantId, session.tenantId),
        ),
      )
      .limit(1);

    // Membership revoked, or the tenant suspended, since the session was issued. Refresh is the
    // right place to notice: it is the only regular checkpoint between 15-minute access tokens.
    if (!membership || membership.isActive === false) {
      await this.revokeSession(session.id);
      throw invalid();
    }

    const [user] = await this.db
      .select({ id: users.id, email: users.email, name: users.name, locale: users.locale })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    if (!user) throw invalid();

    // Rotate: the old row is revoked and a new one is chained to it.
    const next = await this.createSession({
      userId: session.userId,
      tenantId: session.tenantId,
      ip: input.ip,
      userAgent: input.userAgent,
      parentId: session.id,
    });
    await this.revokeSession(session.id);

    return {
      claims: {
        tenantId: session.tenantId,
        sub: user.id,
        sid: next.id,
        rol: membership.role,
      },
      refreshToken: next.token,
      refreshExpiresAt: next.expiresAt,
      user: { id: user.id, email: user.email, name: user.name, locale: user.locale },
      tenant: {
        id: session.tenantId,
        name: membership.name,
        slug: membership.slug,
        role: membership.role,
      },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
  }

  /**
   * Revoke a whole rotation chain, walking to the root and back down. Bounded iteration: a chain
   * cannot meaningfully exceed the number of refreshes in SESSION_TTL_DAYS, and an unbounded
   * recursive CTE on a corrupt parent cycle would hang the request.
   */
  async revokeChain(sessionId: string): Promise<void> {
    const seen = new Set<string>([sessionId]);
    let frontier = [sessionId];

    // Walk up to the root.
    for (let i = 0; i < 200 && frontier.length; i++) {
      const [row] = await this.db
        .select({ parentId: authSessions.parentId })
        .from(authSessions)
        .where(eq(authSessions.id, frontier[0]!))
        .limit(1);
      if (!row?.parentId || seen.has(row.parentId)) break;
      seen.add(row.parentId);
      frontier = [row.parentId];
    }

    // Walk down from everything seen, collecting descendants. inArray (parameterized) rather than
    // an interpolated ARRAY[...] literal: these ids come from the database today, but building
    // SQL by string concatenation is a habit that eventually meets input that does not.
    let queue = [...seen];
    for (let i = 0; i < 200 && queue.length; i++) {
      const children = await this.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(inArray(authSessions.parentId, queue));
      queue = children.map((c) => c.id).filter((id) => !seen.has(id));
      queue.forEach((id) => seen.add(id));
    }

    for (const id of seen) await this.revokeSession(id);
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
  }

  /** Switch the acting tenant. Issues a NEW session rather than mutating the current one, so the
   *  old refresh token cannot be replayed to regain the previous tenant. */
  async switchTenant(input: {
    userId: string;
    tenantId: string;
    currentSessionId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<LoginResult> {
    const memberships = await this.listMemberships(input.userId);
    const membership = memberships.find((m) => m.tenantId === input.tenantId);
    if (!membership) throw new ForbiddenError('You are not a member of that workspace');

    const [user] = await this.db
      .select({ id: users.id, email: users.email, name: users.name, locale: users.locale })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const session = await this.createSession({
      userId: input.userId,
      tenantId: input.tenantId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    if (input.currentSessionId) await this.revokeSession(input.currentSessionId);

    return {
      claims: {
        tenantId: input.tenantId,
        sub: user.id,
        sid: session.id,
        rol: membership.role,
      },
      refreshToken: session.token,
      refreshExpiresAt: session.expiresAt,
      user: { id: user.id, email: user.email, name: user.name, locale: user.locale },
      tenant: {
        id: membership.tenantId,
        name: membership.name,
        slug: membership.slug,
        role: membership.role,
      },
    };
  }

  // ── Password reset ────────────────────────────────────────────────────────────────────────

  /**
   * Returns the raw token for the caller to email, or null when the email is unknown.
   * The ROUTE must respond identically either way — see auth.routes.ts.
   */
  async createPasswordReset(email: string): Promise<{ token: string; userId: string } | null> {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1);
    if (!user) return null;

    // Only one live reset at a time: an older emailed link must stop working the moment a newer
    // one is requested, or a stale mailbox stays a way in.
    await this.db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(authTokens.userId, user.id),
          eq(authTokens.purpose, 'password_reset'),
          isNull(authTokens.usedAt),
        ),
      );

    const { token, hash } = generateToken();
    await this.db.insert(authTokens).values({
      userId: user.id,
      purpose: 'password_reset',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    });

    return { token, userId: user.id };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const hash = hashToken(token);
    const [row] = await this.db
      .select({
        id: authTokens.id,
        userId: authTokens.userId,
        usedAt: authTokens.usedAt,
        expiresAt: authTokens.expiresAt,
      })
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, hash), eq(authTokens.purpose, 'password_reset')))
      .limit(1);

    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('This reset link is invalid or has expired');
    }

    const passwordHash = await hashPassword(newPassword);

    await this.db.transaction(async (tx) => {
      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
      await tx
        .update(users)
        .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, row.userId));
    });

    // A password reset is the standard response to "someone else may have my account". Leaving
    // their existing sessions alive would defeat the point.
    await this.revokeAllUserSessions(row.userId);
  }

  // ── Invites ───────────────────────────────────────────────────────────────────────────────

  /** Returns the raw token for the caller to email. Re-inviting replaces the open invite. */
  async createInvite(input: {
    tenantId: string;
    email: string;
    role: TenantRole;
    invitedByUserId: string;
  }): Promise<{ token: string; inviteId: string }> {
    const email = normalizeEmail(input.email);

    const [alreadyMember] = await this.db
      .select({ id: tenantMembers.id })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(and(eq(tenantMembers.tenantId, input.tenantId), eq(users.email, email)))
      .limit(1);
    if (alreadyMember) throw new ConflictError('That person is already a member');

    // Supersede any open invite — the partial unique index would reject a second one anyway,
    // and silently reusing the old token would surprise whoever just clicked "invite".
    await this.db
      .update(invites)
      .set({ acceptedAt: new Date(), acceptedUserId: null })
      .where(
        and(
          eq(invites.tenantId, input.tenantId),
          eq(invites.email, email),
          isNull(invites.acceptedAt),
        ),
      );

    const { token, hash } = generateToken();
    const [row] = await this.db
      .insert(invites)
      .values({
        tenantId: input.tenantId,
        email,
        role: input.role,
        tokenHash: hash,
        invitedByUserId: input.invitedByUserId,
        expiresAt: daysFromNow(INVITE_TTL_DAYS),
      })
      .returning({ id: invites.id });

    return { token, inviteId: row!.id };
  }

  async acceptInvite(input: {
    token: string;
    password?: string;
    name?: string;
  }): Promise<{ userId: string; tenantId: string }> {
    const hash = hashToken(input.token);
    const [invite] = await this.db
      .select({
        id: invites.id,
        tenantId: invites.tenantId,
        email: invites.email,
        role: invites.role,
        acceptedAt: invites.acceptedAt,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .where(eq(invites.tokenHash, hash))
      .limit(1);

    if (!invite || invite.acceptedAt || invite.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('This invitation is invalid or has expired');
    }

    const [existing] = await this.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, invite.email))
      .limit(1);

    // A brand-new user must set a password here; an existing user just gains a membership and
    // keeps the password they already have.
    if (!existing && !input.password) {
      throw new ValidationError('A password is required to create your account');
    }

    return this.db.transaction(async (tx) => {
      let userId = existing?.id;
      if (!userId) {
        const [created] = await tx
          .insert(users)
          .values({
            email: invite.email,
            passwordHash: await hashPassword(input.password!),
            name: input.name ?? null,
            // Accepting an emailed invite proves control of the mailbox.
            emailVerifiedAt: new Date(),
          })
          .returning({ id: users.id });
        userId = created!.id;
      }

      await tx
        .insert(tenantMembers)
        .values({ tenantId: invite.tenantId, userId, role: invite.role })
        .onConflictDoNothing();

      await tx
        .update(invites)
        .set({ acceptedAt: new Date(), acceptedUserId: userId })
        .where(eq(invites.id, invite.id));

      return { userId, tenantId: invite.tenantId };
    });
  }

  // ── Members ───────────────────────────────────────────────────────────────────────────────

  async listMembers(tenantId: string) {
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: tenantMembers.role,
        lastLoginAt: users.lastLoginAt,
        joinedAt: tenantMembers.createdAt,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(eq(tenantMembers.tenantId, tenantId))
      .orderBy(tenantMembers.createdAt);
  }

  async updateMemberRole(tenantId: string, userId: string, role: TenantRole): Promise<void> {
    await this.assertNotLastOwner(tenantId, userId, role);
    const updated = await this.db
      .update(tenantMembers)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
      .returning({ id: tenantMembers.id });
    if (updated.length === 0) throw new NotFoundError('Member', userId);
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    await this.assertNotLastOwner(tenantId, userId, null);
    await this.db
      .delete(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));
    // Their sessions for this tenant must die now, not in 15 minutes.
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.userId, userId),
          eq(authSessions.tenantId, tenantId),
          isNull(authSessions.revokedAt),
        ),
      );
  }

  /**
   * A tenant with no owner cannot be administered by anyone, and nothing in the system can repair
   * it short of direct SQL. Postgres cannot express "at least one owner" as a constraint, so it
   * is enforced here — on both the demote path and the remove path.
   */
  private async assertNotLastOwner(
    tenantId: string,
    userId: string,
    newRole: TenantRole | null,
  ): Promise<void> {
    if (newRole === 'owner') return;

    const [current] = await this.db
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
      .limit(1);
    if (current?.role !== 'owner') return;

    const owners = await this.db
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, 'owner')));

    if (owners.length <= 1) {
      throw new ValidationError(
        'This is the only owner of the workspace. Promote another member to owner first.',
      );
    }
  }
}
