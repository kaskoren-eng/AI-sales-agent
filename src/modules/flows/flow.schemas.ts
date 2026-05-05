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

const emailStepSchema = z.object({
  type: z.literal('send_email'),
  delayMinutes: z.number().int().min(0).max(10080),
  content: z.object({
    subject: z.string().max(998),
    html: z.string().max(100_000),
  }),
});

const updateMondayStepSchema = z.object({
  type: z.literal('update_monday'),
  delayMinutes: z.number().int().min(0).max(10080),
  // Column ID → value. Values support {{name}}, {{callSummary}}, {{meetingLink}}, {{meetingTime}}, {{meetingDate}}, {{phone}}
  columnValues: z.record(z.string(), z.string()),
});

const bookCalendarStepSchema = z.object({
  type: z.literal('book_calendar'),
  delayMinutes: z.number().int().min(0).max(10080),
  // Optional event description. Supports interpolation. Booking uses the next available slot.
  notes: z.string().max(2000).optional(),
});

const flowStepSchema = z.discriminatedUnion('type', [
  whatsappStepSchema,
  callStepSchema,
  emailStepSchema,
  updateMondayStepSchema,
  bookCalendarStepSchema,
]);

export const flowDefinitionSchema = z.object({
  enabled: z.boolean(),
  steps: z.array(flowStepSchema).min(1).max(20),
});

export type FlowStep = z.infer<typeof flowStepSchema>;
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
