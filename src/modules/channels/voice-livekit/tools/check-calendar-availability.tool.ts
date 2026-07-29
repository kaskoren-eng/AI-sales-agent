import { llm } from '@livekit/agents';
import { z } from 'zod';
import {
  BOOKING_BUFFER_MINUTES,
  BOOKING_TIMEZONE,
  DEFAULT_MEETING_MINUTES,
  filterBusinessHours,
  groupAvailability,
  slotClock,
} from './israel-time.js';
import type { TimeSlot } from '../../../scheduling/providers/provider.interface.js';
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

/** Cap on discrete slot_datetimes returned to the model (she speaks RANGES, not this list). Bounds
 * the result size on a wide multi-day search; a single day is well under it. */
const MAX_SLOTS_LISTED = 40;

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

  // Present availability as RANGES per day ("יש לי פנוי מ-10:00 עד 15:00"), not a list of times.
  // The discrete slots (with slot_datetimes) are still returned, indented under each day, so when
  // the lead names a time she books THAT exact slot — the anti-hallucination guard is unchanged.
  const step = duration + BOOKING_BUFFER_MINUTES;
  const days = groupAvailability(usable, step, now);
  let remaining = MAX_SLOTS_LISTED;

  const blocks = days.map((d) => {
    const ranges = d.windows.map((w) => (w.from === w.to ? w.from : `${w.from}–${w.to}`)).join(', ');
    const shown = d.slots.slice(0, Math.max(0, remaining));
    remaining -= shown.length;
    const lines = shown.map((s) => `  ${slotClock(s.start)} [slot_datetime: ${s.start}]`);
    return `${d.dayLabel} — פנוי ${ranges}:\n${lines.join('\n')}`;
  });
  const truncated =
    usable.length > MAX_SLOTS_LISTED
      ? `\n(+${usable.length - MAX_SLOTS_LISTED} more times not listed — narrow to one day.)`
      : '';

  return (
    `Availability for ${duration}-minute demos (Israel time). Offer the free RANGE(s) out loud — ` +
    `e.g. "יש לי פנוי מ-10:00 עד 15:00, איזו שעה מתאימה לך?" — do NOT read out every time. When he ` +
    `names a time, book the MATCHING slot below by passing its slot_datetime to book_meeting VERBATIM. ` +
    `If his time is not listed, tell him the nearest available times. Never invent a time.\n\n` +
    `${blocks.join('\n\n')}${truncated}`
  );
}

/** She says this if the calendar takes longer than the 500ms tool budget. */
const CHECKING_FILLER_HE = 'שנייה, אני בודקת את היומן...';

export function checkCalendarAvailabilityTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: 'check_calendar_availability',
    description:
      "Check Koren's calendar for free demo times on a given day (or range). ALWAYS call this before " +
      'offering any meeting time — ideally for ONE day at a time (from_date = to_date). Returns the ' +
      "free time RANGES per day (offer these out loud as a range) plus each day's exact slot_datetime " +
      'values (use the one matching the time the lead picks). NEVER invent or guess a time.',
    parameters: checkAvailabilitySchema,
    execute: (args, { ctx }) =>
      ctx.filler(CHECKING_FILLER_HE, { delay: 500 }, () =>
        timedTool(rt, 'check_calendar_availability', args, () => executeCheckAvailability(rt, args)),
      ),
  });
}
