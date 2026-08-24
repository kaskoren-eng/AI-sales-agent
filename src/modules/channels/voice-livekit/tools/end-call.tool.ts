import { once } from 'node:events';
import { getJobContext, llm, voice } from '@livekit/agents';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { leads } from '../../../../db/schema/index.js';
import { END_DISCLOSURE_INSTRUCTION, hasAiDisclosure } from '../compliance/ai-disclosure.js';
import { phoneSuffix } from './book-meeting.tool.js';
import { timedTool, type ToolRuntimeContext } from './tool-context.js';

/**
 * end_call(reason) — hang up gracefully, and remember WHY.
 *
 * The built-in `beta.createEndCallTool` does the teardown correctly but takes no argument from
 * the LLM, and the reason is the entire analytics value of this tool: `meeting_booked` vs
 * `not_interested` vs `opt_out` is how the weekly review reads a week of calls without listening
 * to all of them. So this is a re-implementation of the built-in's exact teardown choreography
 * (node_modules/@livekit/agents/dist/beta/tools/end_call.js) with a reason enum on top, minus
 * the RealtimeModel branch we can never hit (this agent runs a cascade openai.LLM).
 *
 * The choreography, in order:
 *   1. execute() returns an instruction string → the LLM speaks ONE goodbye sentence.
 *   2. speechHandle.addDoneCallback → session.shutdown() fires only AFTER the goodbye finished
 *      playing. Hanging up mid-goodbye is a hang-up, not a goodbye.
 *   3. The session Close event → jobCtx.deleteRoom() (disconnects the SIP caller — this is what
 *      actually ends the phone call) + jobCtx.shutdown(reason).
 * getJobContext(false) is null-safe, so console mode and tests end the session without a room.
 *
 * opt_out is special: Israeli spam law says a person who asked not to be called must not be
 * called again. The lead's status flips to 'opted_out' HERE, synchronously, before the goodbye —
 * and the flow-executor's make_call step refuses to dial any lead in that status.
 */

/** Reasons the LLM may choose when it calls end_call. */
export const LLM_END_REASONS = [
  'meeting_booked',
  'not_qualified',
  'not_interested',
  'callback_requested',
  'opt_out',
  'wrong_person',
  'bad_time',
  'other',
] as const;

/**
 * Reasons set ONLY by a code reflex (silence → no_answer, answering machine → voicemail) — never
 * offered to the model. Kept out of the tool's enum so the LLM can't self-select them; the reflexes
 * in agent.ts write `rt.endReason` directly.
 */
export const SYSTEM_END_REASONS = ['no_answer', 'voicemail'] as const;

/** The full analytics/CRM vocabulary: what the model can pick PLUS what reflexes set. */
export const END_CALL_REASONS = [...LLM_END_REASONS, ...SYSTEM_END_REASONS] as const;

export type EndCallReason = (typeof END_CALL_REASONS)[number];

export const endCallSchema = z.object({
  reason: z
    .enum(LLM_END_REASONS)
    .describe(
      'Why the call is ending. meeting_booked = a demo was booked; not_qualified = budget/fit too low; ' +
        'not_interested = declined; callback_requested = asked to be called another time; ' +
        'opt_out = asked NOT to be contacted again (do-not-call); wrong_person = not the lead; ' +
        'bad_time = busy right now; other = anything else.',
    ),
});

/** 'opted_out' on a lead is a DNC mark. The flow executor refuses to dial it. */
export const LEAD_STATUS_OPTED_OUT = 'opted_out';

/**
 * Flips the lead to do-not-call, tenant-scoped on every path. Outbound calls know their lead;
 * inbound callers are matched by phone; an unknown caller gets a minimal lead row created so the
 * opt-out SURVIVES — a DNC request we can't attach to anyone is a legal problem waiting to recur.
 */
export async function markLeadOptedOut(
  rt: ToolRuntimeContext,
): Promise<'lead_updated' | 'lead_created' | 'no_identity'> {
  // Drain the background lead writes first: a capture/book upsert still in flight may be about to
  // set rt.leadId or create the very row this must flip. DNC is the one write worth blocking for.
  await rt.pendingLeadWrites;
  if (rt.leadId) {
    await rt.db
      .update(leads)
      .set({ status: LEAD_STATUS_OPTED_OUT, updatedAt: new Date() })
      .where(and(eq(leads.id, rt.leadId), eq(leads.tenantId, rt.tenantId)));
    return 'lead_updated';
  }

  const suffix = phoneSuffix(rt.callerPhone ?? '');
  if (suffix.length >= 7) {
    const existing = await rt.db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, rt.tenantId),
          sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') LIKE ${`%${suffix}`}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      await rt.db
        .update(leads)
        .set({ status: LEAD_STATUS_OPTED_OUT, updatedAt: new Date() })
        .where(and(eq(leads.id, existing[0]!.id), eq(leads.tenantId, rt.tenantId)));
      return 'lead_updated';
    }
    // NOT BILLABLE (usage-metering: exempt — suppression record). This row exists so we never
    // call this number again; it is a do-not-contact entry, not a sales lead. Someone who says
    // "take me off your list" should not appear as a billable unit on their invoice — that is a
    // charge no customer will accept and none of us would want to defend.
    //
    // Reversible if Koren disagrees: it is one meterLead call. Flagged in the handoff.
    await rt.db.insert(leads).values({
      tenantId: rt.tenantId,
      phone: rt.callerPhone!,
      source: 'voice-livekit',
      status: LEAD_STATUS_OPTED_OUT,
    });
    return 'lead_created';
  }

  console.error('opt_out_unattributable', JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId }));
  return 'no_identity';
}

function onceEvent<T>(
  session: voice.AgentSession,
  event: string,
  options: { signal: AbortSignal },
): Promise<T | undefined> {
  return once(session as unknown as NodeJS.EventEmitter, event, options).then(
    ([payload]) => payload as T,
    (err) => {
      if (options.signal.aborted) return undefined;
      throw err;
    },
  );
}

/**
 * The graceful hang-up choreography — shared by end_call AND the code reflexes (silence/voicemail),
 * so a reflex-issued hang-up ends the call exactly the way the tool does. In order:
 *   - the just-spoken line (`speechHandle`) finishes PLAYING → session.shutdown() (hanging up
 *     mid-sentence is a hang-up, not a goodbye);
 *   - the session Close event → jobCtx.deleteRoom() (this disconnects the SIP caller) + jobCtx.shutdown().
 * `getJobContext(false)` is null-safe, so console/test mode ends the session without a room.
 */
/** The handle returned by session.say()/tool speech — typed via the public API so we don't depend
 * on a deep SDK import path for the `SpeechHandle` class. */
type SpeechHandleLike = ReturnType<voice.AgentSession['say']>;

export function runEndCallTeardown(
  session: voice.AgentSession,
  speechHandle: SpeechHandleLike,
  abortSignal?: AbortSignal,
): void {
  const controller = new AbortController();
  const signal = abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal;

  void onceEvent<{ reason: unknown }>(session, voice.AgentSessionEventTypes.Close, { signal })
    .then((event) => {
      if (!event) return;
      controller.abort();
      const jobCtx = getJobContext(false);
      if (!jobCtx) return; // console/test mode — no room to delete
      jobCtx.addShutdownCallback(async () => {
        await jobCtx.deleteRoom();
      });
      jobCtx.shutdown(String(event.reason));
    })
    .catch((err) => console.error('end_call_shutdown_error', err instanceof Error ? err.message : String(err)));

  // The line finishes PLAYING, then the session shuts down. Cascade LLM only — the built-in's
  // RealtimeModel wait-for-reply branch is dead code for us.
  speechHandle.addDoneCallback(() => session.shutdown());
}

/**
 * What the LLM is told after the hang-up is armed. When the transcript shows no AI disclosure
 * happened during the call, the goodbye must carry it — end-of-call disclosure is the documented
 * product decision for the Israeli market (see compliance/ai-disclosure.ts, incl. the EU caveat).
 */
export function goodbyeInstruction(reason: EndCallReason, needsAiDisclosure = false): string {
  return (
    `The call is ending (reason: ${reason}). Say ONE short, warm goodbye sentence in Hebrew. ` +
    'Nothing else — no new questions, no new information.' +
    (needsAiDisclosure ? ` ${END_DISCLOSURE_INSTRUCTION}` : '')
  );
}

export function endCallTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'end_call',
    description:
      'End the current phone call gracefully. Call when the conversation is complete: a meeting was ' +
      'booked and confirmed, the lead is not qualified, they declined, they asked not to be contacted, ' +
      'or they asked to end. After this tool you speak exactly one goodbye sentence and the call ends. ' +
      'Do NOT call it to pause or hold.',
    parameters: endCallSchema,
    execute: (args, { ctx, abortSignal }) =>
      timedTool(rt, 'end_call', args, async () => {
        const { reason } = args;
        rt.endReason = reason;
        rt.callState?.onToolCall('end_call', true); // → terminal stage

        // The DNC mark happens BEFORE teardown — a shutdown race must not lose a legal request.
        if (reason === 'opt_out') {
          try {
            const outcome = await markLeadOptedOut(rt);
            console.log('lead_opted_out', JSON.stringify({ tenantId: rt.tenantId, outcome }));
          } catch (err) {
            console.error('opt_out_mark_failed', err instanceof Error ? err.message : String(err));
          }
        }

        // The graceful goodbye → hang-up sequence, shared with the reflex paths.
        runEndCallTeardown(ctx.session, ctx.speechHandle, abortSignal);

        // AI disclosure — decided from the TRANSCRIPT, never from the model's memory of itself.
        const disclosedDuringCall = rt.report.someAgentLine(hasAiDisclosure);
        if (disclosedDuringCall) {
          rt.report.recordCompliance({ ai_disclosure: 'during_call' });
        } else {
          // The goodbye must carry it; shutdown re-scans the transcript to confirm it actually did
          // (report.resolveAiDisclosure → 'at_end' or, if the model ignored us, 'missed').
          rt.report.markEndDisclosureRequested();
        }

        return goodbyeInstruction(reason, !disclosedDuringCall);
      }),
  });
}
