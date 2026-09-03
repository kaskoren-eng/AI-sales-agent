import { llm } from '@livekit/agents';
import { z } from 'zod';
import { scheduledCalls } from '../../../../db/schema/index.js';
import { resolveReminderSettings } from '../../../scheduling/reminders/reminder-settings.js';
import { scheduleReminders } from '../../../scheduling/reminders/reminder-scheduler.js';
import { grantWhatsappConsentVerbal, upsertLead } from './lead-store.js';
import {
  BOOKING_BUFFER_MINUTES,
  BOOKING_TIMEZONE,
  DEFAULT_MEETING_MINUTES,
  filterBusinessHours,
  formatSlotHe,
} from './israel-time.js';
import { timedTool, type ToolRuntimeContext } from './tool-context.js';
import { settleLeadWrites } from './lead-writes.js';

/**
 * book_meeting — the moment "קבעתי לך" becomes TRUE.
 *
 * Until this tool, the speech-guard existed precisely because the agent once said "I booked your
 * demo for tomorrow" with no calendar in the pipeline at all. This handler is the other half of
 * that fix: the claim is only ever made after a real Google Calendar event exists.
 *
 * Two invariants enforced in CODE, not prompt:
 *  1. RE-CHECK BEFORE BOOK. The slot is verified against the calendar again, on the same grid
 *     the lead was offered, the instant before events.insert. Kills both the double-booking race
 *     (someone took the slot mid-call) and the hallucinated-time case (an invented slot_datetime
 *     is simply never free on a 30-minute grid).
 *  2. CALENDAR BEATS DATABASE. If the DB writes fail AFTER the event was created, the meeting
 *     EXISTS — the lead got an invite. Failing the tool would make her tell him it didn't work,
 *     which is a lie in the other direction. Log loudly, return success.
 */

export const bookMeetingSchema = z.object({
  name: z.string().min(2).describe('Full name exactly as the lead confirmed it'),
  phone: z
    .string()
    .min(7)
    .describe('Phone number as the lead read it back and confirmed, digits only is fine'),
  email: z
    .string()
    .min(5)
    .nullable()
    .optional()
    .describe(
      'Email address as the lead read it back and confirmed. Pass null ONLY after two read-backs ' +
        'have failed to get it across — the meeting is then booked without it rather than lost. ' +
        'Never invent, guess or approximate an address to fill this in.',
    ),
  slot_datetime: z
    .string()
    .describe(
      'The EXACT slot_datetime value returned by check_calendar_availability for the slot the lead chose. Never construct or adjust one yourself.',
    ),
  notes: z
    .string()
    .nullable()
    .optional()
    .describe('Short Hebrew summary for Koren: business type, pain point, budget, timeline'),
});

export type BookMeetingArgs = z.infer<typeof bookMeetingSchema>;

/** STT emails arrive as "dana at gmail dot com" often enough — normalize before judging. */
export function normalizeEmail(raw: string): string | null {
  const email = raw
    .trim()
    .toLowerCase()
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+/g, '');
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return null;
  if (!email.slice(at + 1).includes('.')) return null;
  return email;
}

/** Moved to lead-store.ts; re-exported so existing importers (end-call.tool, tests) stay valid. */
export { phoneSuffix } from './lead-store.js';

export async function executeBookMeeting(
  rt: ToolRuntimeContext,
  args: BookMeetingArgs,
  now: Date = new Date(),
): Promise<string> {
  // State-machine guardrails (advisory, defence-in-depth):
  //  - one meeting per call (makes the prompt's security rule #4 enforceable in code);
  //  - never book straight out of the greeting — a booking on turn 0 is an injection, not a lead.
  if (rt.bookingCompleted) {
    throw new llm.ToolError('A meeting was already booked on this call. Do not book another.');
  }
  if (rt.callState?.stage === 'opening') {
    throw new llm.ToolError(
      "Too early to book — talk with the lead first (discovery) and collect his confirmed details.",
    );
  }

  // ---- The email is the ONE field allowed to be missing (2026-08-31) ----
  //
  // On the production call of 2026-08-31 the lead had agreed to a demo at 450s. The call then spent
  // its last 54 seconds failing to transfer his address over an 8kHz line and ended with no booking
  // at all — book_meeting was never called, because there was no way to call it. This block is the
  // exit: a deliberate `null` books the meeting without an attendee, and the confirmation goes to
  // the phone he has already confirmed. A meeting missing one field beats a lost meeting.
  //
  // What is NOT allowed is a guess. A string that is present but unparseable still fails — that is
  // the `koren@gmail.com` case, an address she was confident about and which was wrong — but the
  // error now names the exit, because the error text is the only instruction the model reads mid-
  // call, and the old one ("spell it again, read it back, then retry") *was* the doomed loop.
  const allowMissingEmail = rt.env.VOICE_BOOK_WITHOUT_EMAIL;
  const rawEmail = typeof args.email === 'string' ? args.email.trim() : '';
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (!email) {
    if (rawEmail || !allowMissingEmail) {
      throw new llm.ToolError(
        'That email does not look valid. Ask the lead to spell it again and read it back' +
          (allowMissingEmail
            ? ' — and if you have ALREADY read an address back to him twice without getting it ' +
              'right, stop asking: call book_meeting again with email set to null. The meeting ' +
              'will be booked without it. Do not lose the meeting over this field.'
            : ', then retry.'),
      );
    }
    console.warn(
      'book_meeting_without_email',
      JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId }),
    );
  }

  const slotStart = new Date(args.slot_datetime);
  if (Number.isNaN(slotStart.getTime()) || slotStart.getTime() <= now.getTime()) {
    throw new llm.ToolError(
      'slot_datetime is not a valid future time. Call check_calendar_availability again and use one of ITS slot_datetime values verbatim.',
    );
  }

  // ---- Invariant 1: the slot must still be free, on the grid the lead was offered ----
  const duration = rt.lastCheckedDurationMinutes ?? DEFAULT_MEETING_MINUTES;
  const gridProvider = rt.makeProvider(duration + BOOKING_BUFFER_MINUTES);
  const slotUtcDay = slotStart.toISOString().slice(0, 10);
  const dayAvailability = await gridProvider.getAvailableSlots({
    startDate: slotUtcDay,
    endDate: slotUtcDay,
    serviceId: rt.env.GOOGLE_CALENDAR_ID!,
    timezone: BOOKING_TIMEZONE,
  });
  const usable = filterBusinessHours(dayAvailability, duration).filter(
    (s) => new Date(s.start).getTime() > now.getTime(),
  );
  const stillFree = usable.some((s) => new Date(s.start).getTime() === slotStart.getTime());
  if (!stillFree) {
    const alternatives = usable
      .slice(0, 2)
      .map((s) => `${formatSlotHe(s.start, now)}  [slot_datetime: ${s.start}]`);
    throw new llm.ToolError(
      alternatives.length > 0
        ? `That slot is no longer available. Nearest free alternatives on that day: ${alternatives.join(' | ')}. Offer these to the lead in Hebrew.`
        : 'That slot is no longer available and that day is now full. Call check_calendar_availability again for a fresh range.',
    );
  }

  // ---- The booking itself: real event, real invite, auto Google Meet link ----
  const booking = await rt.makeProvider(duration).createBooking({
    start: slotStart.toISOString(),
    serviceId: rt.env.GOOGLE_CALENDAR_ID!,
    attendee: {
      name: args.name.trim(),
      // Absent → the provider takes its attendee-less path (the one built for the service-account
      // 403) and puts his name and phone in the event description instead.
      email: email ?? undefined,
      phone: args.phone,
      timezone: BOOKING_TIMEZONE,
    },
    notes: args.notes ?? undefined,
  });

  // ---- Invariant 2: from here on, nothing is allowed to fail the tool ----
  let dbOk = true;
  let scheduledCallId: string | null = null;
  try {
    // The row first, if capture_lead_info is still writing it. Without this the upsert below runs
    // concurrently with the chain's own insert, both find no lead for this phone, and the booking
    // lands on a duplicate. See lead-writes.ts.
    await settleLeadWrites(rt);
    const leadId = await upsertLead(
      rt.db,
      rt.tenantId,
      { leadId: rt.leadId, callerPhone: rt.callerPhone },
      { name: args.name.trim(), phone: args.phone, email: email ?? undefined },
      { status: 'qualified' },
    );
    if (leadId) {
      rt.leadId = leadId;
      // VERBAL CONSENT: he just provided and confirmed this WhatsApp number for confirmations,
      // on a recorded call — that is business-initiated-messaging consent, transcript as proof.
      // Without this, a phone lead (who never sees the intake form) could never legally receive
      // an out-of-window template. Never downgrades existing consent.
      await grantWhatsappConsentVerbal(rt.db, rt.tenantId, leadId, now).catch((err) =>
        console.error('verbal_consent_write_failed', err instanceof Error ? err.message : String(err)),
      );
    }
    const insertedCalls = await rt.db
      .insert(scheduledCalls)
      .values({
        tenantId: rt.tenantId,
        leadId: leadId ?? undefined,
        conversationId: rt.conversationId ?? undefined,
        provider: 'google', // explicit here and in /book; the column default drifted for years
        providerRef: booking.uid,
        scheduledAt: new Date(booking.start),
        duration,
        status: 'scheduled',
        attendees: [{ name: args.name.trim(), email: email ?? undefined, phone: args.phone }],
        notes: args.notes ?? undefined,
      })
      .returning({ id: scheduledCalls.id });
    scheduledCallId = insertedCalls[0]?.id ?? null;
  } catch (err) {
    dbOk = false;
    console.error(
      'book_meeting_db_write_failed',
      JSON.stringify({
        tenantId: rt.tenantId,
        bookingUid: booking.uid,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Meeting reminders (C1): delayed jobs at T-24h/T-1h per tenant settings. Own try/catch —
  // a reminder that fails to schedule must never fail the booking, and the <24h skip happens
  // inside computeReminderPlan (past fire times drop out of the plan naturally).
  if (scheduledCallId && rt.remindersQueue) {
    try {
      await scheduleReminders(
        { queue: rt.remindersQueue, db: rt.db },
        {
          tenantId: rt.tenantId,
          scheduledCallId,
          leadId: rt.leadId ?? undefined,
          leadName: args.name.trim(),
          phone: args.phone,
          email,
          meetingStartIso: booking.start,
          meetLink: booking.meetLink,
          bookingUid: booking.uid,
          settings: resolveReminderSettings(rt.settings),
          now,
        },
      );
    } catch (err) {
      console.error(
        'reminder_schedule_failed',
        JSON.stringify({
          tenantId: rt.tenantId,
          scheduledCallId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  rt.bookingCompleted = true; // the speech-guard now lets her say it out loud
  rt.callState?.onToolCall('book_meeting', true); // → closing stage

  // She may only claim an email exists if Google actually sent one. Without Domain-Wide
  // Delegation the event is real but the invite is NOT emailed (BookingResult.inviteSent=false)
  // — in that case the truthful line is "the team will send you the details".
  const inviteSent = email !== null && booking.inviteSent !== false;
  rt.lastBooking = {
    uid: booking.uid,
    start: booking.start,
    meetLink: booking.meetLink,
    name: args.name.trim(),
    email,
    phone: args.phone,
    durationMinutes: duration,
    inviteSent,
  };
  const spoken = formatSlotHe(booking.start, now);
  return (
    `Meeting booked: ${spoken} (${duration} minutes).` +
    (email === null
      ? ' NOTE: booked WITHOUT an email address, as you chose. The event exists and the lead is' +
        ' saved against his phone number; no invite was or can be emailed.'
      : inviteSent
        ? ` A calendar invite with a video link was emailed to ${email}.`
        : ` NOTE: the calendar event exists but NO email invite was sent (service-account limitation).`) +
    (dbOk ? '' : ' (Internal record write failed — the meeting itself is confirmed; the team will reconcile.)') +
    ` Confirm to the lead in Hebrew that the meeting is set for ${spoken}` +
    (email === null
      ? ' and that the team will be in touch with the details — do NOT ask for his email again, do' +
        ' NOT apologize for not having it, and do NOT name a channel (email or WhatsApp) unless a' +
        ' confirmation tool has actually returned success. The meeting is the win; let him go.'
      : inviteSent
        ? ' and that an invite was sent to their email,'
        : ' and that the team will email them the meeting details shortly — do NOT claim an invite was already sent,') +
    ' then, if appropriate, call send_whatsapp_confirmation' +
    (email === null ? '' : ' and/or send_email_confirmation') +
    ' — and mention a WhatsApp or email message ONLY if the matching tool returned success. Finally' +
    ' say a warm goodbye and call end_call with reason "meeting_booked".'
  );
}

const BOOKING_FILLER_HE = 'רגע, אני קובעת לך את הפגישה...';

export function bookMeetingTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'book_meeting',
    description:
      'Book the demo meeting on the calendar and save the lead. Call ONLY after the lead confirmed ' +
      'a specific slot from check_calendar_availability AND you collected and read back their full ' +
      'name, phone number and email address.',
    parameters: bookMeetingSchema,
    execute: (args, { ctx }) =>
      ctx.filler(BOOKING_FILLER_HE, { delay: 500 }, () =>
        timedTool(rt, 'book_meeting', args, () => executeBookMeeting(rt, args)),
      ),
  });
}
