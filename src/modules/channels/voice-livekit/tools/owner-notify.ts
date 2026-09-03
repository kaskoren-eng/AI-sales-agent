import { enqueueOutbound } from '../../../../queues/outbound-sender.queue.js';
import type { WhatsappTemplateKey } from '../../whatsapp/whatsapp-window.js';
import type { HandoffSettings } from './handoff-settings.js';
import { timeboxedEnqueue, type ToolRuntimeContext } from './tool-context.js';

/**
 * PINGING THE BUSINESS OWNER — one implementation, two callers.
 *
 * Lifted VERBATIM out of `request-human-handoff.tool.ts` on 2026-09-03, when the mid-call-disconnect
 * work needed the same thing: a WhatsApp message plus an email to whoever `tenants.settings.handoff`
 * names, queued through the outbound sender, with every failure reduced to a log line.
 *
 * WHY IT MOVED RATHER THAN BEING COPIED. The handoff alert took two live iterations to get right
 * (the first one pinged nobody; the second carried a reason slot that told Koren nothing he did not
 * already know), and all of that lives in the details this function holds: the `notifyRole: 'owner'`
 * metadata that lets the outbound worker treat the owner's own number as consent, the 1.5s enqueue
 * timebox so a hung Redis never delays the caller, and the `owner_not_notified` warning that is the
 * only trace left when a tenant has configured no contact at all. A second copy would have drifted
 * from the first the moment either was fixed.
 *
 * NOTHING ABOUT THE HANDOFF'S BEHAVIOUR CHANGED IN THE MOVE. What was hard-coded is now passed in —
 * the body text, the email subject, the template, and the log prefix — and the handoff tool passes
 * exactly what it used to build inline. Its own test file was not touched, deliberately: those
 * tests assert the queued jobs field by field, so their staying green IS the proof the extraction
 * was clean.
 *
 * THE CONTRACT, unchanged: this never throws and never blocks. The lead on the phone must not pay
 * for our plumbing — an unconfigured owner, a dead queue, or a Redis that hangs all end the same
 * way, with a log line and a call that continues normally.
 */

export interface OwnerAlert {
  /** The lead this is about — rides on the queued job so the dashboard can thread it. */
  leadId: string | null;
  /** The full alert body, newline-separated. WhatsApp sends it as-is; email gets `<br>`s. */
  text: string;
  /** Email subject line. */
  subject: string;
  /** The approved WhatsApp template and its variables. Omitted → freeform only. */
  template?: { key: WhatsappTemplateKey; variables: Record<string, string> };
  /**
   * Prefixes this alert's three log lines (`<prefix>_notify_skipped`, `<prefix>_notify_failed`,
   * `<prefix>_owner_not_notified`), so one grep separates a handoff ping from a disconnect ping.
   */
  logPrefix: string;
}

/**
 * Queues the owner notifications per `settings.handoff.notify`. Every failure path is a log line,
 * never a thrown error — the lead must hear the handoff line regardless of our plumbing. Returns
 * which channels were actually queued (for the truthful tool result).
 */
export async function notifyOwner(
  rt: ToolRuntimeContext,
  cfg: HandoffSettings,
  alert: OwnerAlert,
): Promise<Array<'whatsapp' | 'email'>> {
  const queued: Array<'whatsapp' | 'email'> = [];
  if (!rt.outboundQueue) {
    console.warn(`${alert.logPrefix}_notify_skipped`, JSON.stringify({ tenantId: rt.tenantId, reason: 'no_queue' }));
    return queued;
  }
  const text = alert.text;

  if (cfg.notify.includes('whatsapp') && cfg.ownerPhone) {
    try {
      await timeboxedEnqueue(() =>
        enqueueOutbound(rt.outboundQueue!, {
          tenantId: rt.tenantId,
          channel: 'whatsapp',
          to: cfg.ownerPhone!,
          content: text,
          ...(alert.template ? { template: alert.template } : {}),
          leadId: alert.leadId ?? undefined,
          // notifyRole:'owner' → the outbound worker treats the configured owner phone as consent
          // (they put their own number in settings); the 24h-window/template logic still applies.
          metadata: { source: 'voice-livekit', callId: rt.callId, notifyRole: 'owner' },
        }),
      );
      queued.push('whatsapp');
    } catch (err) {
      console.warn(
        `${alert.logPrefix}_notify_failed`,
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
          subject: alert.subject,
          content: text.split('\n').join('<br>'),
          leadId: alert.leadId ?? undefined,
          metadata: { source: 'voice-livekit', callId: rt.callId, notifyRole: 'owner' },
        }),
      );
      queued.push('email');
    } catch (err) {
      console.warn(
        `${alert.logPrefix}_notify_failed`,
        JSON.stringify({ tenantId: rt.tenantId, channel: 'email', error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  if (queued.length === 0) {
    console.warn(
      `${alert.logPrefix}_owner_not_notified`,
      JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId, configured: { phone: !!cfg.ownerPhone, email: !!cfg.ownerEmail } }),
    );
  }
  return queued;
}
