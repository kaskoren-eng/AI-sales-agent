import { pgTable, uuid, varchar, timestamp, jsonb, integer, bigint, index, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

/**
 * WHAT A CUSTOMER OWES, AND WHAT THEY COST US.
 *
 * Two separate questions that people constantly conflate, so they get separate columns:
 *
 *   - **Billable units** are LEADS. `docs/gtm/pricing-model.md` sells ₪1,490 for 150 leads and
 *     ₪2,490 for 400, with per-lead overage. That is what appears on an invoice.
 *   - **Measured cost** is minutes, tokens and characters. It never appears on an invoice; it is
 *     the margin signal, and the pricing doc flags that real cost/minute has never been measured.
 *     Recording it is the only way that ⚠️ ever gets resolved.
 *
 * The ledger (`usage_events`) is the truth. `usage_periods` is a CACHE of it — a running counter
 * so quota enforcement doesn't aggregate the ledger on every lead intake. If the counter drifts,
 * recompute it from the ledger. That direction is recoverable; the other is not, which is why the
 * ledger insert is the thing that has to be right.
 */

export const BILLING_STATUSES = ['trialing', 'active', 'past_due', 'suspended'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const QUOTA_ENFORCEMENT_MODES = ['off', 'soft', 'hard'] as const;
export type QuotaEnforcement = (typeof QUOTA_ENFORCEMENT_MODES)[number];

export const USAGE_KINDS = ['lead', 'call'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * THE LEDGER. Append-only, one row per billable thing that happened.
 *
 * Every column here exists because an invoice dispute is unwinnable without it. "You billed me for
 * 214 leads" is answered by selecting the rows, not by trusting a counter.
 */
export const usageEvents = pgTable('usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),

  /** 'lead' — billable. 'call' — cost only, never billed. See the header. */
  kind: varchar('kind', { length: 20 }).notNull(),

  /**
   * THE IDEMPOTENCY KEY, and the single most important column in this table.
   *
   * A BullMQ job that succeeds and then fails to ack is retried; a webhook is delivered twice; a
   * worker is SIGKILLed between the write and the commit. Without the unique index below, each of
   * those double-bills a customer, and the customer is the one who notices.
   *
   * Lead events key on the lead id, call events on the room name. Both are already unique per
   * tenant, so the key needs no generation step that could itself be non-deterministic.
   */
  dedupeKey: varchar('dedupe_key', { length: 128 }).notNull(),

  /** What goes on the invoice line. 1 per lead; 0 for call rows, which are cost-only. */
  billableUnits: integer('billable_units').notNull().default(0),

  /**
   * Measured cost in MILLI-AGOROT (1/100,000 of a shekel).
   *
   * Not agorot: a 30-second call costs a fraction of an agora, and rounding per call to the nearest
   * agora destroys exactly the signal this column exists to provide — it would round most calls to
   * zero and the monthly total would read as free.
   */
  costMilliAgorot: bigint('cost_milli_agorot', { mode: 'number' }).notNull().default(0),

  /**
   * The raw provider usage and the rate card version used to price it. Rates change; without the
   * version, a row from three months ago cannot be explained or re-derived.
   */
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

  /** Which period this fell in, resolved at write time so a late-arriving row can't drift. */
  periodId: uuid('period_id'),

  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // THE GUARANTEE. Scoped to the tenant as well as the kind because a dedupeKey is only ever
  // unique within a tenant, and a global unique index would let one customer's lead id block
  // another's.
  unique('usage_events_dedupe_uq').on(t.tenantId, t.kind, t.dedupeKey),
  // "what did this tenant use this period" — the invoice query and the reconciliation query.
  index('usage_events_tenant_occurred_idx').on(t.tenantId, t.occurredAt),
  index('usage_events_period_idx').on(t.periodId),
  check('usage_events_kind_ck', sql`kind IN ('lead', 'call')`),
]);

/**
 * A billing month, with the plan FROZEN as it was when the period opened.
 *
 * The snapshot columns are not denormalisation for speed. If a customer upgrades on the 20th, the
 * month they are halfway through must not retroactively reprice — reading the plan live would do
 * exactly that, and the customer would receive an invoice for a month they never agreed to.
 */
export const usagePeriods = pgTable('usage_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),

  /** Half-open [start, end). Boundaries are anchor-day midnights in Asia/Jerusalem — see period.ts. */
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),

  // --- frozen plan snapshot ---
  // Deliberately NOT a foreign key, unlike `tenants.planCode`. A snapshot has to survive the thing
  // it snapshotted: retiring a plan must never rewrite or block the history of periods billed on it.
  planCode: varchar('plan_code', { length: 40 }),
  monthlyPriceAgorot: integer('monthly_price_agorot').notNull().default(0),
  /** Superseded by `includedMinutes`; frozen on periods that were priced on leads. */
  includedLeads: integer('included_leads'),
  overagePerLeadAgorot: integer('overage_per_lead_agorot').notNull().default(0),
  /** The billable bundle for this period, frozen at open time. Null = unmetered. */
  includedMinutes: integer('included_minutes'),
  overagePerMinuteAgorot: integer('overage_per_minute_agorot').notNull().default(0),

  // --- running totals, derivable from the ledger ---
  leadsUsed: integer('leads_used').notNull().default(0),
  callsCount: integer('calls_count').notNull().default(0),
  /**
   * Voice seconds used, the counter the bundle is measured against.
   *
   * SECONDS, not minutes, because this is a running total of a raw measurement and rounding must
   * happen once — at the point a bill is written — not on every call. Rounding each call up to a
   * whole minute here would silently inflate a busy month by the number of calls made.
   */
  secondsUsed: integer('seconds_used').notNull().default(0),
  measuredCostMilliAgorot: bigint('measured_cost_milli_agorot', { mode: 'number' }).notNull().default(0),

  /** 'open' | 'closed'. Closed periods are what an invoice is written from. */
  status: varchar('status', { length: 20 }).notNull().default('open'),

  /** The manual SUMIT invoice this period was billed on. Manual by decision, not by omission. */
  invoiceRef: varchar('invoice_ref', { length: 100 }),
  closedAt: timestamp('closed_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // One period per tenant per start. This is what makes ensureOpenPeriod safe under a race: two
  // concurrent leads at the top of a month both try to open the period, one loses, both then read
  // the same row.
  unique('usage_periods_tenant_start_uq').on(t.tenantId, t.periodStart),
  index('usage_periods_tenant_status_idx').on(t.tenantId, t.status),
]);

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type UsagePeriod = typeof usagePeriods.$inferSelect;
export type NewUsagePeriod = typeof usagePeriods.$inferInsert;
