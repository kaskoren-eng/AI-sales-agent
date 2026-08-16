import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Third-party OAuth grants, per tenant. Today: Google Calendar.
 *
 * ── Why a table and not `tenants.settings` ────────────────────────────────────────────────────
 *
 * Every other integration credential in this codebase lives in the `settings` jsonb blob, so this
 * looks inconsistent. It is deliberate, for a reason specific to refresh tokens:
 *
 * A refresh cycle is a READ-MODIFY-WRITE of the whole `settings` column. The agent process does it
 * mid-call, from a different machine, while the dashboard may be writing the same column — and
 * jsonb has no partial update through Drizzle's `.set({ settings })`. Two writers, one blob, last
 * write wins: the tenant's business profile silently reverts, or the freshly-rotated access token
 * is overwritten with the stale one and the next booking 401s. Rows and columns make that a
 * non-event.
 *
 * The tokens themselves are AES-256-GCM ciphertext (`src/shared/crypto.ts`), same as every other
 * stored secret. ⚠️ They are therefore bound to `ENCRYPTION_KEY` — see the rotation note in
 * CLAUDE.md before rotating it.
 */
export const oauthConnections = pgTable(
  'oauth_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** `google_calendar` today. A varchar rather than a pg enum so adding one is not a migration. */
    provider: varchar('provider', { length: 40 }).notNull(),

    /** Encrypted. Google only returns this ONCE, on the first consent with `prompt=consent`. */
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    /** Encrypted. Short-lived (~1h) and refreshed on demand; null until the first refresh. */
    accessTokenEncrypted: text('access_token_encrypted'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),

    /** Which Google account consented — shown in the dashboard so a tenant can see who is linked. */
    accountEmail: varchar('account_email', { length: 255 }),
    /** Which calendar bookings go into. Usually 'primary'. */
    calendarId: varchar('calendar_id', { length: 255 }).default('primary').notNull(),
    /** Space-separated granted scopes, as Google returned them — not as we requested them. */
    scope: text('scope'),

    /**
     * Set when Google tells us the grant is dead (`invalid_grant`), so the dashboard can say
     * "reconnect" instead of the agent silently failing to book on every call. A revoked row is
     * kept rather than deleted: which account WAS connected is the first question asked when a
     * customer reports that bookings stopped.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One live connection per provider per tenant. Reconnecting UPDATES this row rather than
    // accumulating grants, so there is never a question of which of two rows is authoritative.
    uniqueIndex('oauth_connections_tenant_provider_key').on(table.tenantId, table.provider),
  ],
);

export type OAuthConnection = typeof oauthConnections.$inferSelect;
export type NewOAuthConnection = typeof oauthConnections.$inferInsert;
