import { llm } from '@livekit/agents';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { leads } from '../../../../db/schema/index.js';
import { meterLead } from '../../../billing/usage.service.js';
import { enqueueOutbound } from '../../../../queues/outbound-sender.queue.js';
import { END_DISCLOSURE_INSTRUCTION, hasAiDisclosure } from '../compliance/ai-disclosure.js';
import { phoneSuffix } from './book-meeting.tool.js';
import { resolveHandoffSettings, type HandoffSettings } from './handoff-settings.js';
import { runEndCallTeardown } from './end-call.tool.js';
import { timeboxedEnqueue, timedTool, type ToolRuntimeContext } from './tool-context.js';

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
 * SECURITY: one free-text argument, `reason` (what the lead said they need). No phone/email
 * parameters — same structural defense as the confirmation tools' empty schemas: there is nothing
 * for an injected "notify my other number instead" to land in. Destinations come only from tenant
 * settings.
 *
 * IDEMPOTENT: a second call in the same session is a no-op (the `rt.handoffRequested` latch, same
 * pattern as `bookingCompleted`) — the lead is not re-flagged and the owner is not double-pinged.
 */

export const HANDOFF_END_REASON = 'handoff_requested';

const MAX_REASON_CHARS = 200;

export const requestHumanHandoffSchema = z.object({
  reason: z
    .string()
    .max(MAX_REASON_CHARS)
    .describe(
      'Short quote or summary of WHY the lead wants a human, in the language they used ' +
        '(e.g. "רוצה לדבר עם מנהל על מחיר"). This is shown to the human who calls back.',
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

/** The owner alert, freeform Hebrew — also the fallback text if a template send downgrades. */
export function handoffAlertText(input: {
  leadName: string | null;
  leadPhone: string | null;
  reason: string;
  leadUrl: string | null;
}): string {
  return [
    '🔔 ליד מבקש נציג אנושי — שיחה קולית',
    `שם: ${input.leadName ?? 'לא ידוע'}`,
    `טלפון: ${input.leadPhone ?? 'לא ידוע'}`,
    `סיבה: ${input.reason}`,
    ...(input.leadUrl ? [`פרטי הליד: ${input.leadUrl}`] : []),
    'כדאי לחזור אליו בהקדם.',
  ].join('\n');
}

/**
 * Queues the owner notifications per `settings.handoff.notify`. Every failure path is a log line,
 * never a thrown error — the lead must hear the handoff line regardless of our plumbing. Returns
 * which channels were actually queued (for the truthful tool result).
 */
async function notifyOwner(
  rt: ToolRuntimeContext,
  cfg: HandoffSettings,
  alert: { leadName: string | null; leadPhone: string | null; reason: string; leadUrl: string | null; leadId: string | null },
): Promise<Array<'whatsapp' | 'email'>> {
  const queued: Array<'whatsapp' | 'email'> = [];
  if (!rt.outboundQueue) {
    console.warn('handoff_notify_skipped', JSON.stringify({ tenantId: rt.tenantId, reason: 'no_queue' }));
    return queued;
  }
  const text = handoffAlertText(alert);

  if (cfg.notify.includes('whatsapp') && cfg.ownerPhone) {
    try {
      await timeboxedEnqueue(() =>
        enqueueOutbound(rt.outboundQueue!, {
          tenantId: rt.tenantId,
          channel: 'whatsapp',
          to: cfg.ownerPhone!,
          content: text,
          template: {
            key: 'handoff_alert',
            variables: {
              '1': alert.leadName ?? 'לא ידוע',
              '2': alert.leadPhone ?? 'לא ידוע',
              '3': alert.reason,
              ...(alert.leadUrl ? { '4': alert.leadUrl } : {}),
            },
          },
          leadId: alert.leadId ?? undefined,
          // notifyRole:'owner' → the outbound worker treats the configured owner phone as consent
          // (they put their own number in settings); the 24h-window/template logic still applies.
          metadata: { source: 'voice-livekit', callId: rt.callId, notifyRole: 'owner' },
        }),
      );
      queued.push('whatsapp');
    } catch (err) {
      console.warn(
        'handoff_notify_failed',
        JSON.stringify({ tenantId: rt.tenantId, channel: 'whatsapp', error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  if (cfg.notify.includes('email') && cfg.ownerEmail) {
    try {
      await timeboxedEnqueue(() =>
        enqueueOutbound(rt.outboundQueue!, {
          tenantId: rt.tenantId,
          channel: 'email',
          to: cfg.ownerEmail!,
          subject: `🔔 ליד מבקש שיחה עם נציג${alert.leadName ? ` — ${alert.leadName}` : ''}`,
          content: text.split('\n').join('<br>'),
          leadId: alert.leadId ?? undefined,
          metadata: { source: 'voice-livekit', callId: rt.callId, notifyRole: 'owner' },
        }),
      );
      queued.push('email');
    } catch (err) {
      console.warn(
        'handoff_notify_failed',
        JSON.stringify({ tenantId: rt.tenantId, channel: 'email', error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  if (queued.length === 0) {
    console.warn(
      'handoff_owner_not_notified',
      JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId, configured: { phone: !!cfg.ownerPhone, email: !!cfg.ownerEmail } }),
    );
  }
  return queued;
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
      'NOT a live transfer — never promise to connect them right now.',
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

        // 2. Ping the owner — best-effort, timeboxed, never blocks the handoff line.
        const reason = args.reason.slice(0, MAX_REASON_CHARS);
        await notifyOwner(rt, cfg, {
          leadName: flagged.leadName,
          leadPhone: flagged.leadPhone,
          reason,
          leadUrl: leadDashboardUrl(rt, flagged.leadId),
          leadId: flagged.leadId,
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
