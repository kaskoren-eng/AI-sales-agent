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
  current_process: z
    .string()
    .nullable()
    .optional()
    .describe(
      'How enquiries are handled today — who answers them and how fast, in his own words. ' +
        'One of the three facts required before describing the product.',
    ),
  budget: z.string().nullable().optional().describe('Budget indication, verbatim as stated'),
  timeline: z.string().nullable().optional().describe('When he wants to start'),
  qualification: z
    .enum(['hot', 'warm', 'cold'])
    .nullable()
    .optional()
    .describe('Your current read: hot = ready to book now, warm = interested, cold = weak fit'),
  notes: z.string().nullable().optional().describe('Short Hebrew free-text observation worth keeping'),
  // THE ONLY WAY AN ESTABLISHED NAME/PHONE/EMAIL CAN CHANGE. See fact-memory.ts for the call this
  // came from: a garbled turn ("טל, אוזן") renamed a lead who had already given his name and had
  // it acknowledged. A bare noun in a noisy turn must not be able to do that; an explicit act by
  // the model, described in a sentence it has to mean, can.
  is_correction: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      'Set true ONLY when the lead EXPLICITLY corrected a detail you had already used out loud ' +
        '("actually my name is X", "no, the email is Y"). Never set it because you heard a new ' +
        'word that might be a name — an unclear or garbled turn is not a correction.',
    ),
});

export type CaptureLeadInfoArgs = z.infer<typeof captureLeadInfoSchema>;

export async function executeCaptureLeadInfo(
  rt: ToolRuntimeContext,
  args: CaptureLeadInfoArgs,
): Promise<string> {
  // `!= null` catches BOTH undefined (omitted) and null (the model's "no value here") — an all-empty
  // call is nothing to save, whichever way the field came in. `is_correction` is a MODIFIER, not a
  // fact: on its own it saves nothing, so it must not make an otherwise empty call look non-empty.
  const { is_correction: _isCorrection, ...facts } = args;
  if (!Object.values(facts).some((v) => v != null)) {
    throw new llm.ToolError('Nothing to save — call this only with at least one learned fact.');
  }
  // IDENTITY IS HARDER TO OVERWRITE THAN TO SET. `rt.factMemory` is undefined when
  // VOICE_FACT_MEMORY_ENABLED is off, and then every offered value is accepted exactly as before.
  const verdict = rt.factMemory?.guardIdentity(
    { name: args.name, email: args.email, phone: args.phone },
    args.is_correction === true,
  ) ?? {
    accepted: {
      ...(args.name ? { name: args.name } : {}),
      ...(args.email ? { email: args.email } : {}),
      ...(args.phone ? { phone: args.phone } : {}),
    },
    refused: [],
    rejected: [],
  };

  const leadId = await upsertLead(
    rt.db,
    rt.tenantId,
    { leadId: rt.leadId, callerPhone: rt.callerPhone },
    {
      name: verdict.accepted.name?.trim(),
      email: verdict.accepted.email?.trim().toLowerCase(),
      phone: verdict.accepted.phone,
    },
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
  // The NAME mirrored here is the guarded one: the working memory feeds the handoff summary, and a
  // rename we refused out loud must not reappear in the alert an owner reads.
  rt.callState?.onToolCall('capture_lead_info', true, {
    name: verdict.accepted.name ?? undefined,
    businessType: args.business_type ?? undefined,
    painPoint: args.pain_point ?? undefined,
    budget: args.budget ?? undefined,
    timeline: args.timeline ?? undefined,
    qualification: args.qualification ?? undefined,
  });
  // Qualification facts we DID accept are established too, so the reminder can stop her re-asking
  // for a business she already has (the fact-memory note; see fact-memory.ts).
  if (args.business_type) rt.factMemory?.establish('business', args.business_type);

  // GATE A. The three facts that decide whether she may describe the product yet — read off the
  // tool rather than off her speech, so the gate and the CRM agree about what was learned.
  // `current_process` is the field this model added; the other two already existed and were
  // simply never consulted before a pitch. See sales-gate.ts.
  if (args.business_type) rt.salesGate?.establish('business');
  if (args.current_process) rt.salesGate?.establish('process');
  if (args.pain_point) rt.salesGate?.establish('pain');

  // THE LEAD HIMSELF RULED THIS VALUE OUT. Reported before `refused`, and in stronger words,
  // because it is the failure that has now cost two bookings: on 2026-08-31 she read
  // `k o r e n at gmail dot com` back to a man whose address begins `kas`, he said "לא נכון", and
  // she proposed the identical string again eight seconds later. A refusal the model is not told
  // about is a refusal it will walk straight back into.
  if (verdict.rejected.length > 0) {
    const denied = verdict.rejected.map((r) => `${r.field} «${r.offered}»`).join('; ');
    return (
      `Saved the rest. NOT SAVED: ${denied}. The lead told you out loud that it is wrong, so it cannot be ` +
      'the answer. Do not say it back to him and do not offer it again in any form. Ask him for ' +
      'the part you are unsure of only — in Hebrew, and one piece at a time — and call this tool ' +
      'again with the corrected value. Do not mention any of this to the lead.'
    );
  }

  if (verdict.refused.length === 0) {
    return 'Saved. Continue the conversation naturally — do not mention that you saved anything.';
  }

  // THE CORRECTION LANDS IN HER CONTEXT IMMEDIATELY, which is the point: the tool result is read
  // by the very next inference step, i.e. before she can say the wrong name out loud. A silent
  // refusal would have kept the CRM right and let her greet him as somebody else — which is
  // precisely what happened on 2026-08-29, when the DB coalesce refused the rename and nothing
  // told the model.
  const corrections = verdict.refused
    .map((r) => `${r.field} stays «${r.kept}» (you offered «${r.offered}»)`)
    .join('; ');
  return (
    `Saved. IMPORTANT — I did NOT change what the lead already told you on this call: ${corrections}. ` +
    'Keep using the established value out loud. If he genuinely corrected it, say it back to him ' +
    'to confirm first, and only then call this tool again with is_correction=true. ' +
    'Do not mention any of this to the lead.'
  );
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
