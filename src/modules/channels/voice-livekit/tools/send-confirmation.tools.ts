import { llm } from '@livekit/agents';
import { z } from 'zod';
import { enqueueOutbound } from '../../../../queues/outbound-sender.queue.js';
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
        return (
          `WhatsApp confirmation queued for …${booking.phone.slice(-4)}. ` +
          'You may tell the lead a WhatsApp message is on its way.'
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
        const mail = emailConfirmation(booking);
        await timeboxedEnqueue(() =>
          enqueueOutbound(queue, {
            tenantId: rt.tenantId,
            channel: 'email',
            to: booking.email,
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
