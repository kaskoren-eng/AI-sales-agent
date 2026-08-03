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

// Self-service update (PATCH /tenants/me). A tenant may rename itself and edit its own settings —
// but NOT change its slug (identity) or `isActive` (a tenant must not be able to suspend itself).
export const updateSelfSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

export const updateFlowSchema = z.object({
  flowName: z.string().min(1).default('lead-intake'),
  flow: flowDefinitionSchema,
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type UpdateSelfInput = z.infer<typeof updateSelfSchema>;
export type UpdateFlowInput = z.infer<typeof updateFlowSchema>;
