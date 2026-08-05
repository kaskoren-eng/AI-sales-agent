import { z } from 'zod';
import { flowDefinitionSchema } from '../flows/flow.schemas.js';

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  isActive: z.boolean().optional(),
  settings: z.record(z.string(), z.any()).optional(),
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
