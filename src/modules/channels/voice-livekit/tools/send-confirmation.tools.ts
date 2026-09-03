import { llm } from '@livekit/agents';
import { z } from 'zod';
import { enqueueOutbound } from '../../../../queues/outbound-sender.queue.js';
import { resolveWhatsappTemplates } from '../../whatsapp/whatsapp-window.js';
import { formatSlotHe } from './israel-time.js';
import { timeboxedEnqueue, timedTool, type ToolRuntimeContext } from './tool-context.js';

/**
 * Post-booking confirmation tools — WhatsApp and email, queued from the call.
 *
 * TWO DELIBERATE STRUCTURAL DEFENSES:
 *
 * 1. ZERO ARGUMENTS. Everything — destination, name, time, link — comes from rt.lastBooking,
 *    the record book_meeting created from details COLLECTED AND READ BACK on this call. There is
 *    no parameter for an injected "actually send it to my other number" to land in; the LLM
 *    physically cannot redirect a confirmation.
 *
 * 2. TRUTHFUL RESULT CONTRACT. Success says "queued", never "delivered" (delivery is the
 *    worker's job: window/consent decision, retries, DLQ). Any failure path returns a ToolError
 *    that explicitly tells the model NOT to claim the channel. "Only claim channels that
 *    actually succeeded" is the acceptance criterion, enforced by the only text the model sees.
 *
 * The WhatsApp job carries template slot `meeting_confirmation` + numbered variables
 * ({{1}}=name, {{2}}=slot, {{3}}=link — the documented convention for tenant templates); the
 * WORKER decides freeform-vs-template-vs-blocked from the lead's 24h window + consent.
 */

export const sendWhatsappConfirmationSchema = z.object({});
export const sendEmailConfirmationSchema = z.object({});

function requireBooking(rt: ToolRuntimeContext) {
  if (!rt.lastBooking) {
    throw new llm.ToolError(
      'No meeting has been booked on this call. Book first with book_meeting — and do not claim any confirmation was sent.',
    );
  }
  if (!rt.outboundQueue) {
    throw new llm.ToolError(
      'Messaging is unavailable right now. Do NOT tell the lead a confirmation message was sent; the calendar invite covers it.',
    );
  }
  return { booking: rt.lastBooking, queue: rt.outboundQueue };
}

/** The freeform Hebrew confirmation — also the fallback text when a template send downgrades. */
export function whatsappConfirmationText(booking: {
  name: string;
  start: string;
  meetLink?: string;
}): string {
  const slot = formatSlotHe(booking.start);
  return [
    `היי ${booking.name}! כאן קרן מ-ClickScales 😊`,
    `רק מאשרת — קבענו פגישה ${slot}.`,
    ...(booking.meetLink ? [`זה הלינק לפגישה: ${booking.meetLink}`] : []),
    'אם משהו משתנה, פשוט תענה לי כאן ונתאם מחדש. נתראה!',
  ].join('\n');
}

export function emailConfirmation(booking: { name: string; start: string; meetLink?: string }): {
  subject: string;
  body: string;
} {
  const slot = formatSlotHe(booking.start);
  return {
    subject: `אישור פגישה — ${slot}`,
    body: [
      `היי ${booking.name},`,
      '',
      `הפגישה שלנו נקבעה ${slot}.`,
      ...(booking.meetLink ? [`קישור לפגישה: ${booking.meetLink}`] : []),
      '',
      'אם צריך לשנות את המועד — פשוט השב למייל הזה ונתאם מחדש.',
      '',
      'נתראה,',
      'קרן · ClickScales',
    ].join('\n'),
  };
}

export function sendWhatsappConfirmationTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'send_whatsapp_confirmation',
    description:
      'Queue a WhatsApp confirmation of the meeting that was just booked, to the phone number the ' +
      'lead confirmed during THIS call. Call ONLY after book_meeting succeeded. Tell the lead a ' +
      'WhatsApp message is on its way ONLY if this tool returns success.',
    parameters: sendWhatsappConfirmationSchema,
    execute: (_args, _opts) =>
      timedTool(rt, 'send_whatsapp_confirmation', {}, async () => {
        // No `settleLeadWrites` here on purpose: `requireBooking` throws unless book_meeting has
        // already run, and book_meeting settles the chain itself. `rt.leadId` is resolved by the
        // time this line can be reached. See lead-writes.ts.
        const { booking, queue } = requireBooking(rt);
        await timeboxedEnqueue(() =>
          enqueueOutbound(queue, {
            tenantId: rt.tenantId,
            channel: 'whatsapp',
            to: booking.phone,
            content: whatsappConfirmationText(booking),
            template: {
              key: 'meeting_confirmation',
              variables: {
                '1': booking.name,
                '2': formatSlotHe(booking.start),
                ...(booking.meetLink ? { '3': booking.meetLink } : {}),
              },
            },
            leadId: rt.leadId ?? undefined,
            metadata: { source: 'voice-livekit', callId: rt.callId, bookingUid: booking.uid },
          }),
        );
        // TRUTHFULNESS PRE-FLIGHT (2026-08-31). "Queued" was never the same thing as "will
        // arrive", and for the lead this tool exists to serve it is usually neither. A caller who
        // has only ever phoned us has NO open 24h WhatsApp window, so the outbound worker takes the
        // business-initiated path and needs BOTH a Twilio-capable provider and an approved
        // `meeting_confirmation` template — otherwise it drops the job with a warn log and returns
        // success (`resolveWhatsappSendMode` → blocked / no_template / provider_no_templates).
        // Nothing failed loudly enough for the agent to know, so she promised a message that was
        // never sent. Both preconditions are readable here for free — the templates come from the
        // settings already loaded at call start, the provider from env — so we read them and tell
        // the model the truth instead. This changes only what the MODEL is told; the job is queued
        // either way, because a lead whose window IS open still gets the freeform message.
        const canTemplate =
          Boolean(rt.env.TWILIO_ACCOUNT_SID) &&
          Boolean(resolveWhatsappTemplates(rt.settings).meeting_confirmation?.contentSid);
        return (
          `WhatsApp confirmation queued for …${booking.phone.slice(-4)}. ` +
          (canTemplate
            ? 'You may tell the lead a WhatsApp message is on its way.'
            : 'BUT this tenant has no approved WhatsApp template for meeting confirmations, so it ' +
              'will only be delivered if the lead has messaged us on WhatsApp in the last 24 ' +
              'hours — which a caller who only ever phoned us has not. Do NOT tell him a WhatsApp ' +
              'is coming. Say the team will be in touch with the details.')
        );
      }),
  });
}

export function sendEmailConfirmationTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'send_email_confirmation',
    description:
      'Queue an email confirmation of the meeting that was just booked, to the email address the ' +
      'lead confirmed during THIS call. Call ONLY after book_meeting succeeded. Tell the lead an ' +
      'email is on its way ONLY if this tool returns success.',
    parameters: sendEmailConfirmationSchema,
    execute: (_args, _opts) =>
      timedTool(rt, 'send_email_confirmation', {}, async () => {
        const { booking, queue } = requireBooking(rt);
        // The meeting can now be booked with no email at all (2026-08-31). There is nowhere to send
        // this, and the model must not tell him an email is coming.
        if (!booking.email) {
          throw new llm.ToolError(
            'This meeting was booked without an email address, so there is nothing to send to. Do ' +
              'NOT tell the lead an email is on its way, and do not ask him for the address again.',
          );
        }
        const to = booking.email;
        const mail = emailConfirmation(booking);
        await timeboxedEnqueue(() =>
          enqueueOutbound(queue, {
            tenantId: rt.tenantId,
            channel: 'email',
            to,
            content: mail.body,
            subject: mail.subject,
            leadId: rt.leadId ?? undefined,
            metadata: { source: 'voice-livekit', callId: rt.callId, bookingUid: booking.uid },
          }),
        );
        return (
          `Email confirmation queued for ${booking.email}. ` +
          'You may tell the lead an email is on its way.'
        );
      }),
  });
}
