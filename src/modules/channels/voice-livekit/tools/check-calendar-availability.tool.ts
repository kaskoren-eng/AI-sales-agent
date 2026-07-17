import { llm } from '@livekit/agents';
import { z } from 'zod';
import {
  BOOKING_BUFFER_MINUTES,
  BOOKING_TIMEZONE,
  DEFAULT_MEETING_MINUTES,
  filterBusinessHours,
  formatSlotHe,
  pickSpread,
} from './israel-time.js';
import { timedTool, type ToolRuntimeContext } from './tool-context.js';

/**
 * check_calendar_availability — the ONLY source of truth for what Keren may offer.
 *
 * The anti-hallucination rule ("never invent calendar availability") is enforced twice: here, by
 * returning each slot with a machine `slot_datetime` the LLM must echo back verbatim, and in
 * book_meeting, which re-checks that exact instant against the calendar before booking. The
 * prompt says "only offer returned slots"; the code makes anything else fail.
 */

/** She must not offer a slot that starts in ten minutes — the lead just got off the phone. */
export const MIN_NOTICE_MINUTES = 60;

/** How many options she offers out loud. Three is a conversation; five is a menu. */
const MAX_OFFERED_SLOTS = 3;

export const checkAvailabilitySchema = z.object({
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('First day to search, YYYY-MM-DD in Israel time. Today or later.'),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Last day to search, inclusive, YYYY-MM-DD. At most 14 days after from_date.'),
  duration_minutes: z
    .number()
    .int()
    .min(15)
    .max(120)
    .default(DEFAULT_MEETING_MINUTES)
    .describe(`Meeting length in minutes. Use the default (${DEFAULT_MEETING_MINUTES}) for a demo unless the lead asked otherwise.`),
});

export type CheckAvailabilityArgs = z.infer<typeof checkAvailabilitySchema>;

/**
 * Pure handler — everything the tool does, minus the LiveKit plumbing, so tests drive it with a
 * fake provider and a pinned clock.
 */
export async function executeCheckAvailability(
  rt: ToolRuntimeContext,
  args: CheckAvailabilityArgs,
  now: Date = new Date(),
): Promise<string> {
  const from = new Date(`${args.from_date}T00:00:00Z`);
  const to = new Date(`${args.to_date}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
    throw new llm.ToolError(
      `Invalid date range. Dates must be YYYY-MM-DD with to_date >= from_date. Today is ${now.toISOString().slice(0, 10)}.`,
    );
  }
  // An LLM that got the year wrong asks for last July. Clamp the start to today instead of
  // erroring — the caller is on the line and "no availability" beats a robotic argument about
  // calendars. The clamp is invisible when the dates are sane. It runs BEFORE the width check,
  // so "since the 1st" three weeks into the month still resolves to a legal today→to_date range.
  const todayUtcDay = now.toISOString().slice(0, 10);
  if (args.to_date < todayUtcDay) {
    throw new llm.ToolError(
      `That range is entirely in the past. Today is ${todayUtcDay} — search from today onward.`,
    );
  }
  const fromDate = args.from_date < todayUtcDay ? todayUtcDay : args.from_date;

  if (to.getTime() - new Date(`${fromDate}T00:00:00Z`).getTime() > 14 * 86_400_000) {
    throw new llm.ToolError('Date range too wide — search at most 14 days at a time.');
  }

  // The provider's grid step is meeting + buffer: a free 30-minute block guarantees a 15-minute
  // meeting AND the required 15-minute gap before whatever comes next.
  const duration = args.duration_minutes;
  const provider = rt.makeProvider(duration + BOOKING_BUFFER_MINUTES);
  const raw = await provider.getAvailableSlots({
    startDate: fromDate,
    endDate: args.to_date,
    serviceId: rt.env.GOOGLE_CALENDAR_ID!,
    timezone: BOOKING_TIMEZONE,
  });

  const minStart = now.getTime() + MIN_NOTICE_MINUTES * 60_000;
  const usable = filterBusinessHours(raw, duration).filter(
    (s) => new Date(s.start).getTime() >= minStart,
  );

  // Remember the grid the lead is about to hear — book_meeting re-checks on the SAME grid.
  rt.lastCheckedDurationMinutes = duration;

  if (usable.length === 0) {
    // A valid answer, not an error: the LLM relays it and asks for a different range.
    return (
      `No free slots between ${fromDate} and ${args.to_date}. ` +
      'Tell the lead (in Hebrew) there is no availability in that range and ask which other days could work, then search again.'
    );
  }

  const offered = pickSpread(usable, MAX_OFFERED_SLOTS);
  const lines = offered.map(
    (s, i) => `${i + 1}. ${formatSlotHe(s.start, now)}  [slot_datetime: ${s.start}]`,
  );
  return (
    `Found ${offered.length} free ${duration}-minute slots (Israel time):\n` +
    `${lines.join('\n')}\n` +
    'Offer these verbally in Hebrew, exactly as written. When the lead picks one, pass its ' +
    'slot_datetime value to book_meeting VERBATIM — never construct or adjust a time yourself.'
  );
}

/** She says this if the calendar takes longer than the 500ms tool budget. */
const CHECKING_FILLER_HE = 'שנייה, אני בודקת את היומן...';

export function checkCalendarAvailabilityTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'check_calendar_availability',
    description:
      "Check Koren's calendar for free demo slots. ALWAYS call this before offering any meeting time. " +
      'Returns up to 3 free slots with Hebrew labels and exact slot_datetime values. ' +
      'Only offer times returned by this tool — NEVER invent or guess a time.',
    parameters: checkAvailabilitySchema,
    execute: (args, { ctx }) =>
      ctx.filler(CHECKING_FILLER_HE, { delay: 500 }, () =>
        timedTool(rt, 'check_calendar_availability', args, () => executeCheckAvailability(rt, args)),
      ),
  });
}
