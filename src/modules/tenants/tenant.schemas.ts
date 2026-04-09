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
});

export const updateFlowSchema = z.object({
  flowName: z.string().min(1).default('lead-intake'),
  flow: flowDefinitionSchema,
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type UpdateFlowInput = z.infer<typeof updateFlowSchema>;
