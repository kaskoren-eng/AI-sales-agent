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

// NOTE: must stay a PLAIN z.object — LiveKit's llm.tool() rejects ZodEffects, so the
// "at least one field" rule is enforced in the handler, not with .refine().
//
// EVERY field is .nullable().optional(), not just .optional(). gpt-5.4 fills a tool call's UNKNOWN
// fields with explicit `null`, not by omitting them — and a bare `.optional()` accepts `undefined`
// but REJECTS `null`. On a real call this made capture_lead_info fail Zod validation over and over
// ("Expected string, received null"), the model retried the same null-laden call, and Keren went
// SILENT for 20-44s at a stretch while it looped. Accepting null makes the first call succeed. The
// handler treats null exactly like "not provided" (falsy checks below).
export const captureLeadInfoSchema = z.object({
  name: z.string().min(2).nullable().optional().describe('Full name exactly as the lead stated it'),
  email: z.string().min(5).nullable().optional().describe('Email address if the lead gave one'),
  phone: z
    .string()
    .min(7)
    .nullable()
    .optional()
    .describe('Phone number ONLY if the lead gave one different from the number he is calling from'),
  business_type: z.string().nullable().optional().describe("The lead's business, in his own words"),
  pain_point: z.string().nullable().optional().describe('The concrete problem he wants solved'),
  budget: z.string().nullable().optional().describe('Budget indication, verbatim as stated'),
  timeline: z.string().nullable().optional().describe('When he wants to start'),
  qualification: z
    .enum(['hot', 'warm', 'cold'])
    .nullable()
    .optional()
    .describe('Your current read: hot = ready to book now, warm = interested, cold = weak fit'),
  notes: z.string().nullable().optional().describe('Short Hebrew free-text observation worth keeping'),
});

export type CaptureLeadInfoArgs = z.infer<typeof captureLeadInfoSchema>;

export async function executeCaptureLeadInfo(
  rt: ToolRuntimeContext,
  args: CaptureLeadInfoArgs,
): Promise<string> {
  // `!= null` catches BOTH undefined (omitted) and null (the model's "no value here") — an all-empty
  // call is nothing to save, whichever way the field came in.
  if (!Object.values(args).some((v) => v != null)) {
    throw new llm.ToolError('Nothing to save — call this only with at least one learned fact.');
  }
  const leadId = await upsertLead(
    rt.db,
    rt.tenantId,
    { leadId: rt.leadId, callerPhone: rt.callerPhone },
    { name: args.name?.trim(), email: args.email?.trim().toLowerCase(), phone: args.phone ?? undefined },
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

  // Mirror the gathered facts into the state machine's working memory ("what we know so far") and
  // advance discovery→qualifying on a qualification read. The DB write above stays the source of truth.
  rt.callState?.onToolCall('capture_lead_info', true, {
    name: args.name ?? undefined,
    businessType: args.business_type ?? undefined,
    painPoint: args.pain_point ?? undefined,
    budget: args.budget ?? undefined,
    timeline: args.timeline ?? undefined,
    qualification: args.qualification ?? undefined,
  });

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
