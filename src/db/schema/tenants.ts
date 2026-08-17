import { pgTable, uuid, varchar, timestamp, jsonb, boolean, integer, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { plans } from './plans.js';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  apiKeyHash: varchar('api_key_hash', { length: 64 }).unique(),
  settings: jsonb('settings').default({}),
  isActive: boolean('is_active').default(true),

  // --- BILLING ---
  //
  // Real columns, not `settings` keys, for four reasons that each independently settle it: they are
  // read on the hot auth path, they are queried ACROSS tenants (`WHERE billing_status='past_due'`),
  // `planCode` is FK-constrained, and — the one that matters most — they must be unwritable through
  // `PATCH /tenants/me` BY CONSTRUCTION rather than by a validator somebody later loosens. A
  // customer who can edit their own plan code is a customer who can give themselves a free tier.

  /**
   * Null = no plan assigned yet (a tenant created before a plan was chosen).
   *
   * `restrict`, not `set null`: deleting a plan that live tenants are on should FAIL loudly at the
   * database. The alternative silently unassigns paying customers, and the symptom is an invoice
   * run that quietly skips them.
   */
  planCode: varchar('plan_code', { length: 40 }).references(() => plans.code, { onDelete: 'restrict' }),

  /**
   * Negotiated-deal escape hatches. Koren will absolutely agree "400 leads at the base price" with
   * some customer, and the alternative to these columns is a bespoke plan row per customer, which
   * turns the plans table into a customer table.
   */
  includedLeadsOverride: integer('included_leads_override'),
  overagePerLeadAgorotOverride: integer('overage_per_lead_agorot_override'),
  monthlyPriceAgorotOverride: integer('monthly_price_agorot_override'),

  /** 'trialing' | 'active' | 'past_due' | 'suspended'. */
  billingStatus: varchar('billing_status', { length: 20 }).notNull().default('trialing'),

  /**
   * Which day of the month the billing period turns over — the day they signed, normally.
   *
   * Constrained to 1..28 so the period maths has NO edge case: every month has a 28th, so "the
   * anchor day of next month" always exists. The 29th–31st would need a clamping rule, and every
   * clamping rule is a bug that appears in February and is fixed the following February.
   */
  billingAnchorDay: integer('billing_anchor_day').notNull().default(1),

  /** 'off' | 'soft' | 'hard' — read by Phase 5b. Nothing enforces it yet, by design. */
  quotaEnforcement: varchar('quota_enforcement', { length: 20 }).notNull().default('off'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, () => [
  check('tenants_billing_anchor_day_ck', sql`billing_anchor_day BETWEEN 1 AND 28`),
  check('tenants_billing_status_ck', sql`billing_status IN ('trialing', 'active', 'past_due', 'suspended')`),
  check('tenants_quota_enforcement_ck', sql`quota_enforcement IN ('off', 'soft', 'hard')`),
]);
