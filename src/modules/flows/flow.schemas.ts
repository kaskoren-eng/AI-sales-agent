import { z } from 'zod';

const whatsappStepSchema = z.object({
  type: z.literal('send_whatsapp'),
  delayMinutes: z.number().int().min(0).max(10080), // max 7 days
  content: z.object({
    messageType: z.enum(['video', 'text', 'image']),
    url: z.string().url().optional(),
    caption: z.string().max(1024).optional(),
    text: z.string().max(4096).optional(),
  }),
});

const callStepSchema = z.object({
  type: z.literal('make_call'),
  delayMinutes: z.number().int().min(0).max(10080),
});

const flowStepSchema = z.discriminatedUnion('type', [whatsappStepSchema, callStepSchema]);

export const flowDefinitionSchema = z.object({
  enabled: z.boolean(),
  steps: z.array(flowStepSchema).min(1).max(20),
});

export type FlowStep = z.infer<typeof flowStepSchema>;
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
