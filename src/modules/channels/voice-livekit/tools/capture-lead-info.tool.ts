import { llm } from '@livekit/agents';
import { z } from 'zod';
import { mergeLeadQualification, upsertLead } from './lead-store.js';
import { timedTool, type ToolRuntimeContext } from './tool-context.js';

/**
 * capture_lead_info — the call's memory into the CRM, as it happens.
 *
 * Before this tool, everything the lead said about his business lived only in the transcript:
 * a rich qualification conversation produced a leads row that knew a phone number and nothing
 * else. This saves facts the moment Keren learns them — silently, mid-conversation — so a call
 * that ends without a booking still ends with a qualified, scored lead.
 *
 * Score mapping is MONOTONE (hot→90, warm→60, cold→20, applied as GREATEST): a lead who cooled
 * off at the end still showed hot intent, and the CRM should say so. Status is deliberately NOT
 * touched here — status transitions belong to book_meeting ('qualified') and end_call
 * ('opted_out'), not to a fact-recording tool.
 */

const QUALIFICATION_SCORE_FLOOR: Record<'hot' | 'warm' | 'cold', number> = {
  hot: 90,
  warm: 60,
  cold: 20,
};

export const captureLeadInfoSchema = z
  .object({
    name: z.string().min(2).optional().describe('Full name exactly as the lead stated it'),
    email: z.string().min(5).optional().describe('Email address if the lead gave one'),
    phone: z
      .string()
      .min(7)
      .optional()
      .describe('Phone number ONLY if the lead gave one different from the number he is calling from'),
    business_type: z.string().optional().describe("The lead's business, in his own words"),
    pain_point: z.string().optional().describe('The concrete problem he wants solved'),
    budget: z.string().optional().describe('Budget indication, verbatim as stated'),
    timeline: z.string().optional().describe('When he wants to start'),
    qualification: z
      .enum(['hot', 'warm', 'cold'])
      .optional()
      .describe('Your current read: hot = ready to book now, warm = interested, cold = weak fit'),
    notes: z.string().optional().describe('Short Hebrew free-text observation worth keeping'),
  })
  .refine((args) => Object.values(args).some((v) => v !== undefined), {
    message: 'Provide at least one field — calling this with nothing to save is a mistake.',
  });

export type CaptureLeadInfoArgs = z.infer<typeof captureLeadInfoSchema>;

export async function executeCaptureLeadInfo(
  rt: ToolRuntimeContext,
  args: CaptureLeadInfoArgs,
): Promise<string> {
  const leadId = await upsertLead(
    rt.db,
    rt.tenantId,
    { leadId: rt.leadId, callerPhone: rt.callerPhone },
    { name: args.name?.trim(), email: args.email?.trim().toLowerCase(), phone: args.phone },
  );
  if (!leadId) {
    throw new llm.ToolError('Could not save right now. Continue the call normally; nothing was lost from the conversation.');
  }
  // Later tools (book_meeting, end_call's opt-out) reuse the resolved lead instead of re-matching.
  rt.leadId = leadId;

  const patch: Record<string, unknown> = {};
  if (args.business_type) patch.business_type = args.business_type;
  if (args.pain_point) patch.pain_point = args.pain_point;
  if (args.budget) patch.budget = args.budget;
  if (args.timeline) patch.timeline = args.timeline;
  if (args.qualification) patch.qualification = args.qualification;
  if (args.notes) patch.notes = args.notes;

  if (Object.keys(patch).length > 0) {
    patch.updated_from_call = rt.callId;
    await mergeLeadQualification(
      rt.db,
      rt.tenantId,
      leadId,
      patch,
      args.qualification ? QUALIFICATION_SCORE_FLOOR[args.qualification] : undefined,
    );
  }

  return 'Saved. Continue the conversation naturally — do not mention that you saved anything.';
}

export function captureLeadInfoTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'capture_lead_info',
    description:
      "Silently save qualification facts about the lead as you learn them during the call — business type, " +
      'pain point, budget, timeline, contact details, or your hot/warm/cold read. The lead does not hear ' +
      'this and you must never announce it. Save ONLY what he actually said — never invent or infer values. ' +
      'Call it again whenever a fact changes.',
    parameters: captureLeadInfoSchema,
    execute: (args, _opts) =>
      timedTool(rt, 'capture_lead_info', args as Record<string, unknown>, () =>
        executeCaptureLeadInfo(rt, args),
      ),
  });
}
