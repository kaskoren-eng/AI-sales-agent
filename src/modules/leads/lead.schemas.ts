import { z } from 'zod';

export const createLeadSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  source: z.enum(['whatsapp', 'email', 'voice', 'manual', 'csv', 'google_sheets', 'crm']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateLeadSchema = createLeadSchema.partial().extend({
  status: z.enum(['new', 'contacted', 'qualifying', 'qualified', 'booked', 'disqualified']).optional(),
  score: z.number().int().min(0).max(100).optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
