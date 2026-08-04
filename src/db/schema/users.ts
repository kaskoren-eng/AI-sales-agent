import { pgTable, uuid, varchar, timestamp, boolean, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Identity tables. Until these existed there were no accounts at all: a tenant WAS an API key.
 * The dashboard read `localStorage.auth_token || VITE_API_KEY`, nothing ever wrote it, and the
 * production bundle could ship one tenant's key compiled into the JavaScript. One shared
 * credential per company, no per-person revocation, no audit attribution.
 */

/**
 * USERS ARE GLOBAL, NOT TENANT-SCOPED. One human can belong to several tenants — Koren as the
 * operator today, an agency reselling to its own clients later — and the login box needs a
 * globally unique email to resolve against. Tenant membership lives in `tenant_members`.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stored lowercased and trimmed by the service; the unique index is the login lookup.
  email: varchar('email', { length: 255 }).notNull().unique(),
  /**
   * scrypt, formatted "<saltHex>:<hashHex>" — see hashPassword() in shared/crypto.ts.
   * NULLABLE on purpose: an invited user exists before they have chosen a password, and a user
   * who only ever signs in through an invite link never sets one until they accept.
   */
  passwordHash: varchar('password_hash', { length: 255 }),
  name: varchar('name', { length: 255 }),
  locale: varchar('locale', { length: 8 }).notNull().default('he'),
  /**
   * Platform operator. This is the real answer to the single shared ADMIN_API_KEY in
   * admin.guard.ts — that env key stays as a break-glass path, but an operator with an account
   * is attributable in audit_events and revocable without rotating a secret for everyone.
   */
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  // Throttling state for credential stuffing. Reset on any successful login.
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** owner | admin | member | viewer. Kept as varchar + CHECK rather than a pg enum: adding a role
 *  to a pg enum requires a migration and (on older PG) cannot run inside a transaction. */
export const TENANT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const tenantMembers = pgTable('tenant_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 20 }).notNull().default('member').$type<TenantRole>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('tenant_members_tenant_user_idx').on(t.tenantId, t.userId),
  // "which tenants can I switch to?" — the tenant switcher's query.
  index('tenant_members_user_idx').on(t.userId),
]);

/**
 * A SESSION IS A REFRESH TOKEN. One table, not two: a separate refresh_tokens table would carry
 * exactly the same lifecycle (issued, rotated, revoked, expired) keyed to exactly the same row.
 */
export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /**
   * Which tenant this session is currently acting as. Switching tenants issues a new access token
   * against the SAME session, so a user with two tenants does not re-authenticate to flip between
   * them. Nullable for the window between login and tenant selection.
   */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  // sha256 of an opaque 32-byte random value. The raw token exists only in the httpOnly cookie —
  // a database dump must not yield usable sessions.
  refreshTokenHash: varchar('refresh_token_hash', { length: 64 }).notNull().unique(),
  /**
   * Rotation chain. Every refresh issues a new row pointing at the one it replaced. Presenting a
   * token that was already rotated away means it leaked, so the whole chain is revoked rather
   * than just the presented token.
   */
  parentId: uuid('parent_id'),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 255 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('auth_sessions_user_idx').on(t.userId),
  // The cleanup job's index.
  index('auth_sessions_expires_idx').on(t.expiresAt),
]);

/**
 * Invites carry a tenant and a role, are listed in the members UI, and have their own lifecycle —
 * which is why they are NOT folded into auth_tokens below.
 */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 20 }).notNull().default('member').$type<TenantRole>(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('invites_tenant_idx').on(t.tenantId)]);
// A partial unique index (one OPEN invite per email per tenant) is added as raw SQL in the
// migration — drizzle-kit cannot express `WHERE accepted_at IS NULL` here.

export const AUTH_TOKEN_PURPOSES = ['password_reset', 'email_verify'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * Password reset and email verification share one table because the flows are byte-identical:
 * hash a random token, expire it, allow it exactly once. `purpose` is the only thing that differs.
 */
export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: varchar('purpose', { length: 24 }).notNull().$type<AuthTokenPurpose>(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose)]);
