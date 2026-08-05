import { pgTable, uuid, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Who did what, to which tenant, when.
 *
 * Until now the only record of a consequential action was a log line: `request.log.info({audit:
 * true, ...})`. Those are real and useful, but they live in the platform's log retention, they are
 * not queryable per tenant, and they cannot be shown to a customer asking "who cancelled that
 * booking?" or to a regulator asking "who exported this data?".
 *
 * Deliberately NOT a general activity feed. Rows are written for actions that are hard to undo,
 * touch money, touch credentials, or touch someone else's data — suspensions, key rotations,
 * deletions, role changes, settings writes that were refused. If everything is audited, the audit
 * log is just a slower copy of the request log.
 */
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),

  /**
   * The tenant the action was performed ON. Nullable, because platform-level actions — creating a
   * tenant, an operator signing in — have no tenant yet, and dropping those rows would lose
   * exactly the actions with the widest blast radius.
   */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),

  /**
   * The human who did it, where there was one. `set null` rather than cascade: an audit trail that
   * deletes itself when the actor's account is deleted is not an audit trail. `actorLabel` below
   * survives the deletion so the row still says who it was.
   */
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

  /** 'user' | 'api_key' | 'admin_key' | 'system' — machine actions are attributable too. */
  actorType: varchar('actor_type', { length: 20 }).notNull(),

  /**
   * A denormalised copy of who the actor was (email, or "api_key:clickscales"). Denormalised ON
   * PURPOSE: the point of an audit row is to still mean something after the referenced user, key
   * or tenant is gone.
   */
  actorLabel: varchar('actor_label', { length: 255 }),

  /** Dotted and past-tense: `tenant.suspended`, `api_key.rotated`, `lead.deleted`. */
  action: varchar('action', { length: 64 }).notNull(),

  /** What it was done to — `lead`, `booking`, `tenant`, `member` — and which one. */
  targetType: varchar('target_type', { length: 40 }),
  targetId: varchar('target_id', { length: 128 }),

  /**
   * Action-specific detail: old and new values, the reason for a refusal.
   *
   * MUST NOT contain credentials or PII beyond what the action itself is about. An audit log that
   * quietly accumulates plaintext secrets is a new place to leak them, and it is the one table
   * nobody thinks to redact.
   */
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

  ip: varchar('ip', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // "show me this tenant's recent activity" — the only query the UI will ever run.
  index('audit_events_tenant_created_idx').on(t.tenantId, t.createdAt),
  // "everything this person did" — the query an incident actually needs.
  index('audit_events_actor_idx').on(t.actorUserId, t.createdAt),
  index('audit_events_action_idx').on(t.action, t.createdAt),
]);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
