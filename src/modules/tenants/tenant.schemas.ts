import { z } from 'zod';
import { flowDefinitionSchema } from '../flows/flow.schemas.js';

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  /**
   * REQUIRED, and deliberately not defaulted.
   *
   * A tenant with no `plan_code` bills as free and unlimited: `readEffectivePlan` falls back to
   * `{ monthlyPriceAgorot: 0, includedLeads: null, overagePerLeadAgorot: 0 }`. That would be
   * survivable if it were correctable, but `usage_periods` SNAPSHOTS the plan when the period
   * opens — on purpose, so a mid-month change cannot reprice history — so the free-unlimited
   * snapshot is frozen for the customer's entire first month. Assigning the real plan afterwards
   * does not fix the month you most want to bill for.
   *
   * A default would only choose which wrong answer to be silent about. Whoever creates a
   * workspace has just agreed a price with the customer, so they are the one who knows.
   */
  planCode: z.string().min(1).max(40),
});

/**
 * OPERATOR update (PATCH /api/v1/admin/tenants/:id). Admin-key only.
 *
 * The billing fields live here and NOT on `updateSelfSchema` — a tenant must never be able to move
 * itself onto a cheaper plan, mark itself `active`, or turn off its own quota enforcement. That
 * separation is the reason there are two schemas rather than one with a flag.
 *
 * They were missing entirely until now, which meant a plan could be chosen at creation and then
 * never changed: no upgrade, no downgrade, no way off the internal tier, and no way to mark an
 * account `past_due` when an invoice went unpaid. Every one of those is a normal Tuesday for a
 * business with customers, and each required hand-written SQL against production.
 *
 * The enums are spelled out here rather than left to the database CHECK constraints, so a typo
 * comes back as "Invalid input" naming the valid values instead of a Postgres constraint-violation
 * stack trace. The CHECK constraints stay as the last line of defence, not the first.
 */
export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  isActive: z.boolean().optional(),
  settings: z.record(z.string(), z.any()).optional(),
  /** Validated against the `plans` table in the service — this only checks the shape. */
  planCode: z.string().min(1).max(40).optional(),
  billingStatus: z.enum(['trialing', 'active', 'past_due', 'suspended']).optional(),
  quotaEnforcement: z.enum(['off', 'soft', 'hard']).optional(),
});

/**
 * Self-service update (PATCH /tenants/me). A tenant may rename itself — not change its slug
 * (identity), not `isActive` (a tenant must not be able to suspend itself), and NOT `settings`.
 *
 * `settings` used to be here as `z.record(z.string(), z.any())`, written straight through. One
 * jsonb column holds tenant preferences, operator controls and encrypted credentials together, so
 * that field let a tenant raise its own `toll_fraud` spend cap, switch `voice_engine`, or wipe its
 * own stored credentials by sending a partial object — the write REPLACED the column rather than
 * merging into it. Settings now move through PATCH /tenants/me/settings/:namespace, one classified
 * namespace at a time. See settings-policy.ts.
 */
export const updateSelfSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
  })
  .strict(
    'Settings are updated one section at a time via PATCH /tenants/me/settings/:section',
  );

/**
 * The body of PATCH /tenants/me/settings/:namespace — the contents of ONE namespace.
 *
 * Values stay `any` because each namespace has its own shape and its own typed route that
 * validates it properly; this generic path is the escape hatch, and its job is to enforce WHICH
 * section is being written, not what belongs inside it. The route caps the serialised size —
 * `tenants.settings` is read on the voice hot path, so it must not become a dumping ground.
 */
export const updateSettingsNamespaceSchema = z.record(z.string(), z.any());

export const updateFlowSchema = z.object({
  flowName: z.string().min(1).default('lead-intake'),
  flow: flowDefinitionSchema,
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type UpdateSelfInput = z.infer<typeof updateSelfSchema>;
export type UpdateFlowInput = z.infer<typeof updateFlowSchema>;
