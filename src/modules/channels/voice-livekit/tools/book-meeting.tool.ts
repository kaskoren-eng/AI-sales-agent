import { llm } from '@livekit/agents';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { leads, scheduledCalls } from '../../../../db/schema/index.js';
import {
  BOOKING_BUFFER_MINUTES,
  BOOKING_TIMEZONE,
  DEFAULT_MEETING_MINUTES,
  filterBusinessHours,
  formatSlotHe,
} from './israel-time.js';
import { timedTool, type ToolRuntimeContext } from './tool-context.js';

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
  email: z.string().min(5).describe('Email address as the lead read it back and confirmed'),
  slot_datetime: z
    .string()
    .describe(
      'The EXACT slot_datetime value returned by check_calendar_availability for the slot the lead chose. Never construct or adjust one yourself.',
    ),
  notes: z
    .string()
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

/** Last 9 digits — enough to match an Israeli number across +972/0/dashed formats. */
export function phoneSuffix(raw: string): string {
  return raw.replace(/\D/g, '').slice(-9);
}

export async function executeBookMeeting(
  rt: ToolRuntimeContext,
  args: BookMeetingArgs,
  now: Date = new Date(),
): Promise<string> {
  const email = normalizeEmail(args.email);
  if (!email) {
    throw new llm.ToolError(
      'That email does not look valid. Ask the lead to spell it again, read it back, then retry.',
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
    attendee: { name: args.name.trim(), email, phone: args.phone, timezone: BOOKING_TIMEZONE },
    notes: args.notes,
  });

  // ---- Invariant 2: from here on, nothing is allowed to fail the tool ----
  let dbOk = true;
  try {
    const leadId = await upsertLead(rt, { name: args.name.trim(), phone: args.phone, email });
    await rt.db.insert(scheduledCalls).values({
      tenantId: rt.tenantId,
      leadId: leadId ?? undefined,
      conversationId: rt.conversationId ?? undefined,
      provider: 'google', // the legacy /book route leaves this defaulting to 'trafft' — a bug we don't copy
      providerRef: booking.uid,
      scheduledAt: new Date(booking.start),
      duration,
      status: 'scheduled',
      attendees: [{ name: args.name.trim(), email, phone: args.phone }],
      notes: args.notes,
    });
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

  rt.bookingCompleted = true; // the speech-guard now lets her say it out loud

  // She may only claim an email exists if Google actually sent one. Without Domain-Wide
  // Delegation the event is real but the invite is NOT emailed (BookingResult.inviteSent=false)
  // — in that case the truthful line is "the team will send you the details".
  const inviteSent = booking.inviteSent !== false;
  const spoken = formatSlotHe(booking.start, now);
  return (
    `Meeting booked: ${spoken} (${duration} minutes).` +
    (inviteSent
      ? ` A calendar invite with a video link was emailed to ${email}.`
      : ` NOTE: the calendar event exists but NO email invite was sent (service-account limitation).`) +
    (dbOk ? '' : ' (Internal record write failed — the meeting itself is confirmed; the team will reconcile.)') +
    ` Confirm to the lead in Hebrew that the meeting is set for ${spoken}` +
    (inviteSent
      ? ' and that an invite was sent to their email,'
      : ' and that the team will email them the meeting details shortly — do NOT claim an invite was already sent,') +
    ' then say a warm goodbye and call end_call with reason "meeting_booked".'
  );
}

/**
 * Ties the booking to a `leads` row without ever crossing tenants.
 * Outbound calls arrive with rt.leadId; inbound callers are matched by phone (last 9 digits,
 * format-proof via regexp_replace) or created fresh as a qualified voice lead.
 * Returns null only when even the insert failed — the booking still stands.
 */
async function upsertLead(
  rt: ToolRuntimeContext,
  info: { name: string; phone: string; email: string },
): Promise<string | null> {
  if (rt.leadId) {
    await rt.db
      .update(leads)
      .set({
        // Backfill what the call taught us; never blank an existing value.
        name: sql`coalesce(nullif(${leads.name}, ''), ${info.name})`,
        email: sql`coalesce(nullif(${leads.email}, ''), ${info.email})`,
        phone: sql`coalesce(nullif(${leads.phone}, ''), ${info.phone})`,
        status: 'qualified',
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, rt.leadId), eq(leads.tenantId, rt.tenantId)));
    return rt.leadId;
  }

  const suffix = phoneSuffix(info.phone);
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
      const leadId = existing[0]!.id;
      await rt.db
        .update(leads)
        .set({
          name: sql`coalesce(nullif(${leads.name}, ''), ${info.name})`,
          email: sql`coalesce(nullif(${leads.email}, ''), ${info.email})`,
          status: 'qualified',
          updatedAt: new Date(),
        })
        .where(and(eq(leads.id, leadId), eq(leads.tenantId, rt.tenantId)));
      return leadId;
    }
  }

  const inserted = await rt.db
    .insert(leads)
    .values({
      tenantId: rt.tenantId,
      name: info.name,
      phone: info.phone,
      email: info.email,
      source: 'voice-livekit',
      status: 'qualified',
    })
    .returning({ id: leads.id });
  return inserted[0]?.id ?? null;
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
