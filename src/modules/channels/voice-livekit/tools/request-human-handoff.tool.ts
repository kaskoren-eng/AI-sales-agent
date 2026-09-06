import { llm } from '@livekit/agents';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { leads } from '../../../../db/schema/index.js';
import { meterLead } from '../../../billing/usage.service.js';
import { END_DISCLOSURE_INSTRUCTION, hasAiDisclosure } from '../compliance/ai-disclosure.js';
import type { KnownFacts } from '../call-state.js';
import { phoneSuffix } from './book-meeting.tool.js';
import { cancelCallbacksForLead } from './callback-store.js';
import { resolveHandoffSettings } from './handoff-settings.js';
import { runEndCallTeardown } from './end-call.tool.js';
import { notifyOwner } from './owner-notify.js';
import { timedTool, type ToolRuntimeContext } from './tool-context.js';
import { settleLeadWrites } from './lead-writes.js';

/**
 * request_human_handoff(reason) — the answer to "אני רוצה לדבר עם בן אדם".
 *
 * Launch-minimum handoff, NOT a live transfer (no SIP REFER, deliberately — post-launch). Three
 * effects, in order of importance:
 *   1. The lead is durably flagged (`leads.handoff_requested_at = now()`) — the dashboard's
 *      "urgent since". Happens FIRST and synchronously: a shutdown race must not lose the request.
 *   2. The tenant owner is pinged immediately — WhatsApp + email via the outbound queue, per
 *      `tenants.settings.handoff` ({ ownerName, ownerPhone, ownerEmail, notify }). Best-effort:
 *      an unconfigured owner or a dead queue is LOGGED, never surfaced to the lead as a failure.
 *   3. The call ends the way end_call ends it — same teardown choreography (runEndCallTeardown),
 *      same AI-disclosure check, `end_reason = 'handoff_requested'` for analytics/CRM.
 *
 * SECURITY: three free-text arguments — `reason` (why they want a human), `wants` (what they want
 * to discuss) and `context` (what the call already established) — and NO destination parameters.
 * That is the same structural defense as the confirmation tools' empty schemas: there is nothing
 * for an injected "notify my other number instead" to land in. Destinations come only from tenant
 * settings, and every field is length-capped before it reaches the alert.
 *
 * THE SUMMARY IS THE POINT (2026-08-29). The first live handoff pinged nobody and carried
 * `{"reason":"רוצה לדבר עם בן אדם"}` — a line that tells the owner nothing he did not already know.
 * Koren asked for the four things a person needs before calling back: who called, what they want to
 * talk about, what is already established, and why they asked for a human. What must NEVER follow
 * from that: a handoff that waits for the lead to explain themselves. She asks once; the tool runs
 * either way.
 *
 * IDEMPOTENT: a second call in the same session is a no-op (the `rt.handoffRequested` latch, same
 * pattern as `bookingCompleted`) — the lead is not re-flagged and the owner is not double-pinged.
 */

export const HANDOFF_END_REASON = 'handoff_requested';

const MAX_REASON_CHARS = 200;
/** The "what we already know" line. Longer than a reason, still far too short to smuggle a payload. */
const MAX_CONTEXT_CHARS = 400;

export const requestHumanHandoffSchema = z.object({
  reason: z
    .string()
    .max(MAX_REASON_CHARS)
    .describe(
      'Short quote or summary of WHY the lead wants a human, in the language they used ' +
        '(e.g. "רוצה לדבר עם מנהל על מחיר"). This is shown to the human who calls back.',
    ),
  // NULLABLE AND OPTIONAL, both. gpt-5.4 fills a tool call's unknown fields with an explicit
  // `null` rather than omitting them, and a bare `.optional()` REJECTS null — which on a live call
  // means Zod fails the handoff and the model retries while the lead waits. capture_lead_info
  // learned that the expensive way; the same rule binds every optional field we add here.
  wants: z
    .string()
    .max(MAX_REASON_CHARS)
    .nullable()
    .optional()
    .describe(
      'What the lead said they want to discuss with the human, in their own words. OMIT IT if ' +
        'they would not say — never delay or refuse the handoff to get this.',
    ),
  context: z
    .string()
    .max(MAX_CONTEXT_CHARS)
    .nullable()
    .optional()
    .describe(
      'ONE short line of what is already established on this call (business, need, budget, ' +
        'timing), so the person calling back does not start from zero.',
    ),
});

/**
 * Stamps `handoff_requested_at` on the lead, tenant-scoped on every path — same identity ladder
 * as markLeadOptedOut: outbound calls know their lead; inbound callers are matched by phone
 * suffix; an unknown caller gets a minimal lead row so the request SURVIVES the call. Returns the
 * lead's id/name/phone for the owner notification (the dashboard link needs the id).
 */
export async function flagLeadHandoffRequested(rt: ToolRuntimeContext): Promise<{
  outcome: 'lead_updated' | 'lead_created' | 'no_identity';
  leadId: string | null;
  leadName: string | null;
  leadPhone: string | null;
}> {
  const now = new Date();
  // The owner's alert names this lead; a row the background chain has not written yet would send
  // an alert about nobody. See lead-writes.ts.
  await settleLeadWrites(rt);

  if (rt.leadId) {
    const rows = await rt.db
      .update(leads)
      .set({ handoffRequestedAt: now, updatedAt: now })
      .where(and(eq(leads.id, rt.leadId), eq(leads.tenantId, rt.tenantId)))
      .returning({ id: leads.id, name: leads.name, phone: leads.phone });
    const row = rows[0];
    return {
      outcome: 'lead_updated',
      leadId: row?.id ?? rt.leadId,
      leadName: row?.name ?? null,
      leadPhone: row?.phone ?? rt.callerPhone,
    };
  }

  const suffix = phoneSuffix(rt.callerPhone ?? '');
  if (suffix.length >= 7) {
    const existing = await rt.db
      .select({ id: leads.id, name: leads.name, phone: leads.phone })
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, rt.tenantId),
          sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') LIKE ${`%${suffix}`}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      const row = existing[0]!;
      await rt.db
        .update(leads)
        .set({ handoffRequestedAt: now, updatedAt: now })
        .where(and(eq(leads.id, row.id), eq(leads.tenantId, rt.tenantId)));
      return { outcome: 'lead_updated', leadId: row.id, leadName: row.name, leadPhone: row.phone };
    }
    const inserted = await rt.db
      .insert(leads)
      .values({
        tenantId: rt.tenantId,
        phone: rt.callerPhone!,
        source: 'voice-livekit',
        handoffRequestedAt: now,
      })
      .returning({ id: leads.id });
    // Same convention as lead-store.ts: a real lead reached us on the voice channel, so it meters.
    // Unawaited — meterLead swallows its own errors and a handoff must never fail on billing.
    if (inserted[0]?.id) void meterLead(rt.db, { tenantId: rt.tenantId, leadId: inserted[0].id, source: 'voice-livekit' });
    return {
      outcome: 'lead_created',
      leadId: inserted[0]?.id ?? null,
      leadName: null,
      leadPhone: rt.callerPhone,
    };
  }

  console.error('handoff_unattributable', JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId }));
  return { outcome: 'no_identity', leadId: null, leadName: null, leadPhone: null };
}

/** `/leads/:id` deep link — omitted entirely when DASHBOARD_BASE_URL is unset (never a broken URL,
 * same contract as the CRM back-links in Workstream B). */
export function leadDashboardUrl(rt: ToolRuntimeContext, leadId: string | null): string | null {
  const base = rt.env.DASHBOARD_BASE_URL;
  if (!base || !leadId) return null;
  return `${base.replace(/\/$/, '')}/leads/${leadId}`;
}

/**
 * What the call's working memory knows, as one Hebrew line.
 *
 * The state machine already tracks these (capture_lead_info feeds them), so an alert that printed
 * only the model's `context` sentence would be throwing away facts we already hold. Absent fields
 * are omitted rather than printed as "לא ידוע" — a call that learned nothing produces nothing.
 */
export function establishedLine(
  facts: KnownFacts | undefined,
  context: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (facts?.businessType) parts.push(`עסק: ${facts.businessType}`);
  if (facts?.painPoint) parts.push(`צורך: ${facts.painPoint}`);
  if (facts?.budget) parts.push(`תקציב: ${facts.budget}`);
  if (facts?.timeline) parts.push(`זמנים: ${facts.timeline}`);
  if (facts?.qualification) parts.push(`דירוג: ${facts.qualification}`);
  const trimmed = context?.trim();
  if (trimmed) parts.push(trimmed);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The owner alert, freeform Hebrew — also the fallback text if a template send downgrades.
 *
 * WHY IT IS A SUMMARY AND NOT A FIELD (Koren, 2026-08-29). The first live handoff sent him
 * `{"reason":"רוצה לדבר עם בן אדם"}` — the one thing he already knew. "I would like to see a reason
 * why that user want to talk to me rather than talk to Keren. So it should come with a small
 * summary about the reason." Four things a human needs before dialling back: who called, what they
 * want to talk about, what is already established, and why they asked for a person.
 */
export function handoffAlertText(input: {
  leadName: string | null;
  leadPhone: string | null;
  reason: string;
  wants?: string | null;
  established?: string | null;
  leadUrl: string | null;
}): string {
  return [
    '🔔 ליד מבקש נציג אנושי — שיחה קולית',
    `שם: ${input.leadName ?? 'לא ידוע'}`,
    `טלפון: ${input.leadPhone ?? 'לא ידוע'}`,
    ...(input.wants ? [`רוצה לדבר על: ${input.wants}`] : []),
    `סיבה: ${input.reason}`,
    ...(input.established ? [`מה כבר ידוע: ${input.established}`] : []),
    ...(input.leadUrl ? [`פרטי הליד: ${input.leadUrl}`] : []),
    'כדאי לחזור אליו בהקדם.',
  ].join('\n');
}

/**
 * The same summary squeezed onto ONE line, for the WhatsApp template's third variable.
 *
 * The approved `handoff_alert` template has four fixed slots (name, phone, reason, link), so the
 * new detail rides inside the reason slot rather than adding a fifth — and a WhatsApp template
 * variable may not contain a newline.
 */
export function handoffReasonLine(input: {
  reason: string;
  wants?: string | null;
  established?: string | null;
}): string {
  return [
    input.reason,
    ...(input.wants ? [`רוצה לדבר על: ${input.wants}`] : []),
    ...(input.established ? [`ידוע: ${input.established}`] : []),
  ]
    .join(' · ')
    .replace(/\s*\n\s*/gu, ' ')
    .slice(0, 900);
}

/** What the LLM is told after the handoff is recorded and the hang-up is armed. */
export function handoffInstruction(ownerName: string | null, needsAiDisclosure = false): string {
  const who = ownerName
    ? `${ownerName} (use this name)`
    : 'the team (no owner name is configured — say "הצוות שלנו", do NOT invent a name)';
  return (
    'Handoff recorded and the owner is being notified. Now say, in Hebrew, ONE warm sentence telling ' +
    `the lead you are passing this on to ${who} and they will get back to them very soon — then one ` +
    'short goodbye. Nothing else: no new questions, no new information, and do NOT promise an exact ' +
    'callback time.' +
    (needsAiDisclosure ? ` ${END_DISCLOSURE_INSTRUCTION}` : '')
  );
}

export function requestHumanHandoffTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'request_human_handoff',
    description:
      'The lead wants a HUMAN — asked for a person/manager, or refuses to continue with an AI. ' +
      'Flags the lead as urgent and immediately notifies the business owner, who will call back. ' +
      'After this tool you speak exactly one handoff sentence plus a short goodbye and the call ends. ' +
      'NOT a live transfer — never promise to connect them right now. ' +
      'Ask ONE short question about what they want to discuss BEFORE calling this — but if they will ' +
      'not answer, call it anyway with reason alone. A handoff is never conditional on an explanation.',
    parameters: requestHumanHandoffSchema,
    execute: (args, { ctx, abortSignal }) =>
      timedTool(rt, 'request_human_handoff', args, async () => {
        // IDEMPOTENT: the latch flips once; a repeat call must not re-flag or double-ping.
        if (rt.handoffRequested) {
          return 'Handoff already recorded on this call — nothing more to do. Say the handoff line and goodbye if you have not already.';
        }
        rt.handoffRequested = true;
        rt.endReason = HANDOFF_END_REASON;
        rt.callState?.onToolCall('end_call', true); // reuse the terminal-stage transition; the CallReport logs the real tool name

        const cfg = resolveHandoffSettings(rt.settings);

        // 1. The durable flag — BEFORE teardown, a shutdown race must not lose the request.
        let flagged: Awaited<ReturnType<typeof flagLeadHandoffRequested>>;
        try {
          flagged = await flagLeadHandoffRequested(rt);
          console.log('handoff_lead_flagged', JSON.stringify({ tenantId: rt.tenantId, outcome: flagged.outcome }));
        } catch (err) {
          console.error('handoff_flag_failed', err instanceof Error ? err.message : String(err));
          flagged = { outcome: 'no_identity', leadId: rt.leadId, leadName: null, leadPhone: rt.callerPhone };
        }

        // 1b. A lead handed to a human is the human's now, so any automatic callback we had
        // promised is cancelled. Two of us ringing the same person about the same thing is worse
        // than neither — and worse still if the automatic one gets there first and re-opens a
        // conversation the owner is about to have properly.
        //
        // DEFENCE IN DEPTH: this is the one of the four hooks the callback worker does NOT
        // independently re-check at fire time (it re-checks opt-out and bookings; a handoff leaves
        // no row it looks at). So it is the hook that actually changes an outcome — which is also
        // why it still may not throw: `cancelCallbacksForLead` swallows and logs, because a
        // handoff that failed because Redis was down would lose the lead entirely.
        await cancelCallbacksForLead(rt, flagged.leadId, 'cancelled:handoff_requested');

        // 2. Ping the owner — best-effort, timeboxed, never blocks the handoff line.
        //
        // The summary is built from BOTH sides: what she asked the lead (`wants`, `context`) and
        // what the call already recorded on its own (`rt.callState.facts`, fed by capture_lead_info).
        // Either half can be missing — the lead who will not say why still gets handed off, and a
        // call with no state machine (VOICE_STATE_MACHINE_ENABLED=false) still sends an alert.
        const reason = args.reason.slice(0, MAX_REASON_CHARS);
        const wants = args.wants?.trim().slice(0, MAX_REASON_CHARS) || null;
        const established = establishedLine(
          rt.callState?.facts,
          args.context?.slice(0, MAX_CONTEXT_CHARS),
        );
        const alert = {
          leadName: flagged.leadName,
          leadPhone: flagged.leadPhone,
          reason,
          wants,
          established,
          leadUrl: leadDashboardUrl(rt, flagged.leadId),
        };
        // Everything that used to be hard-coded INSIDE notifyOwner is now passed to the shared
        // version verbatim — same body, same subject, same template slots, same log prefix.
        // See owner-notify.ts for why it moved, and why this file's tests were left untouched.
        await notifyOwner(rt, cfg, {
          leadId: flagged.leadId,
          text: handoffAlertText(alert),
          subject: `🔔 ליד מבקש שיחה עם נציג${alert.leadName ? ` — ${alert.leadName}` : ''}`,
          template: {
            key: 'handoff_alert',
            variables: {
              '1': alert.leadName ?? 'לא ידוע',
              '2': alert.leadPhone ?? 'לא ידוע',
              // The whole summary on one line — see handoffReasonLine. The approved template has
              // four slots and a variable cannot contain a newline, so it rides in this one.
              '3': handoffReasonLine(alert),
              ...(alert.leadUrl ? { '4': alert.leadUrl } : {}),
            },
          },
          logPrefix: 'handoff',
        });

        // 3. End the call exactly the way end_call does — shared choreography, shared disclosure rule.
        runEndCallTeardown(ctx.session, ctx.speechHandle, abortSignal);
        const disclosedDuringCall = rt.report.someAgentLine(hasAiDisclosure);
        if (disclosedDuringCall) {
          rt.report.recordCompliance({ ai_disclosure: 'during_call' });
        } else {
          rt.report.markEndDisclosureRequested();
        }

        return handoffInstruction(cfg.ownerName, !disclosedDuringCall);
      }),
  });
}
