import { pgTable, varchar, timestamp, integer, boolean } from 'drizzle-orm/pg-core';

/**
 * The tiers from `docs/gtm/pricing-model.md`, as rows.
 *
 * Its own file, not `billing.ts`, purely so `tenants.planCode` can carry a real foreign key:
 * `billing.ts` imports `tenants` (usage rows point at a tenant), so if `plans` lived there,
 * `tenants` importing it back would be a cycle — and a cycle in drizzle schema modules resolves to
 * `undefined` at import time, which surfaces as an incomprehensible error inside drizzle-kit rather
 * than as a circular-import warning.
 *
 * `code` is the primary key rather than a uuid: it is stable, human-readable, appears in support
 * conversations ("he's on growth"), and a plan is referenced by name far more often than joined.
 * A fourth tier is one INSERT — there is deliberately no plans CRUD screen.
 */
export const plans = pgTable('plans', {
  code: varchar('code', { length: 40 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  nameHe: varchar('name_he', { length: 100 }),

  /**
   * Prices in AGOROT, never a float. ₪1,490.00 is 149000. Money in floating point is how an
   * invoice ends up ₪0.01 off and a customer stops trusting every other number on the page.
   */
  monthlyPriceAgorot: integer('monthly_price_agorot').notNull(),
  setupFeeAgorot: integer('setup_fee_agorot').notNull().default(0),

  /**
   * Leads included before overage. Null = unmetered (bespoke contracts).
   *
   * SUPERSEDED as the billable unit by `includedMinutes` below. Kept, not dropped: every
   * `usage_periods` row already written froze these values into its snapshot, and a snapshot has to
   * stay readable for the month it priced.
   */
  includedLeads: integer('included_leads'),
  overagePerLeadAgorot: integer('overage_per_lead_agorot').notNull().default(0),

  /**
   * THE BILLABLE UNIT: voice minutes included per period before overage. Null = unmetered.
   *
   * The customer buys a bundle of minutes at `monthlyPriceAgorot` and pays
   * `overagePerMinuteAgorot` for each minute beyond it. This is a *price*, in agorot, and has
   * nothing to do with what a minute costs us — that is `usage_periods.measuredCostMilliAgorot`,
   * which is operator-only (see `billing.ts`).
   */
  includedMinutes: integer('included_minutes'),
  overagePerMinuteAgorot: integer('overage_per_minute_agorot').notNull().default(0),

  /** Read by Phase 8's concurrency cap. Stored now so the plan row is complete when it is needed. */
  maxConcurrentCalls: integer('max_concurrent_calls').notNull().default(1),

  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
