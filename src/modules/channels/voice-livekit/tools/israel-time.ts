import type { TimeSlot } from '../../../scheduling/providers/provider.interface.js';

/**
 * Israel-local time rules for the voice agent's calendar tools.
 *
 * WHY THIS FILE EXISTS. `GoogleCalendarProvider.getAvailableSlots()` builds its slot grid in RAW
 * UTC (`${day}T${workStart}:00Z`, provider line 60) and iterates every calendar day — including
 * Friday and Saturday. That is fine for the HTTP API, where the caller passes explicit dates, but
 * a Hebrew sales agent offering "יום שישי בעשר" to an Israeli lead is broken in a way no latency
 * number will ever show. The tool therefore asks the provider for a WIDE UTC window and applies
 * the real business rules here, in Israel local time, DST-safe:
 *
 *   Sunday–Thursday, 09:00–17:00, Asia/Jerusalem.   (hebrew-voice-agent-dev-plan.md, שלב 4)
 *
 * Everything here is a pure function of (instant, timezone) — no Date.now() inside the logic, the
 * current time is always a parameter — so the tests can pin exact instants in both IST (winter,
 * UTC+2) and IDT (summer, UTC+3).
 */

export const BOOKING_TIMEZONE = 'Asia/Jerusalem';

/** User decision (2026-07-17): demo meetings are 15 minutes, per hebrew-voice-agent-dev-plan. */
export const DEFAULT_MEETING_MINUTES = 15;

/** Required gap between meetings. Availability is checked on a (duration + buffer) grid. */
export const BOOKING_BUFFER_MINUTES = 15;

/** Israeli business hours, local time. Sunday work week — NOT Mon–Fri. */
const WORK_DAYS = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
const WORK_START_MINUTES = 9 * 60; // 09:00
const WORK_END_MINUTES = 17 * 60; // 17:00

const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BOOKING_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

const DATE_HE = new Intl.DateTimeFormat('he-IL', {
  timeZone: BOOKING_TIMEZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const TIME_HE = new Intl.DateTimeFormat('he-IL', {
  timeZone: BOOKING_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface IsraelParts {
  year: number;
  month: number;
  day: number;
  minutesOfDay: number;
  /** en-US short weekday: Sun … Sat. */
  weekday: string;
}

function israelParts(instant: Date): IsraelParts {
  const parts: Record<string, string> = {};
  for (const p of PARTS_FMT.formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minutesOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday!,
  };
}

/** The slot's Israel-local calendar date as a UTC-midnight timestamp — for whole-day arithmetic. */
function israelDayStamp(instant: Date): number {
  const p = israelParts(instant);
  return Date.UTC(p.year, p.month - 1, p.day);
}

/**
 * The UTC instant of TODAY's midnight in Israel — the day boundary for daily limits.
 * Two-pass offset trick, DST-safe with no libraries: take 00:00 UTC of the Israel-local date;
 * in Israel that instant reads as 02:00 (IST) or 03:00 (IDT); subtract exactly that offset.
 */
export function startOfIsraelDay(now: Date = new Date()): Date {
  const p = israelParts(now);
  const candidate = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const cp = israelParts(candidate);
  return new Date(candidate.getTime() - cp.minutesOfDay * 60_000);
}

/** Israel-local calendar date as YYYY-MM-DD — the per-day key for counters. */
export function israelDayKey(now: Date = new Date()): string {
  const p = israelParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * "מחר, יום שלישי, 21 ביולי, בשעה 11:00" — how the agent offers a slot out loud.
 *
 * The relative prefix (היום/מחר/מחרתיים) is computed against Israel-local CALENDAR dates, not
 * 24-hour windows: at 00:30 Israel time, a slot ten hours away is "היום", not "מחר". Beyond two
 * days out there is no natural Hebrew word, so the weekday carries the information alone.
 */
export function formatSlotHe(iso: string, now: Date = new Date()): string {
  const instant = new Date(iso);
  const dayDiff = Math.round((israelDayStamp(instant) - israelDayStamp(now)) / 86_400_000);
  const relative = dayDiff === 0 ? 'היום' : dayDiff === 1 ? 'מחר' : dayDiff === 2 ? 'מחרתיים' : null;
  const datePart = DATE_HE.format(instant); // "יום שלישי, 21 ביולי"
  const timePart = TIME_HE.format(instant); // "11:00"
  return relative ? `${relative}, ${datePart}, בשעה ${timePart}` : `${datePart}, בשעה ${timePart}`;
}

/** True iff the meeting fits entirely inside Sun–Thu 09:00–17:00 Israel local time. */
export function isBusinessHours(startIso: string, durationMinutes: number): boolean {
  const p = israelParts(new Date(startIso));
  if (!WORK_DAYS.has(p.weekday)) return false;
  if (p.minutesOfDay < WORK_START_MINUTES) return false;
  return p.minutesOfDay + durationMinutes <= WORK_END_MINUTES;
}

/** Drops every slot the provider generated outside Israeli business hours (incl. Fri/Sat). */
export function filterBusinessHours(slots: TimeSlot[], durationMinutes: number): TimeSlot[] {
  return slots.filter((s) => isBusinessHours(s.start, durationMinutes));
}

/**
 * Picks up to `count` slots spread across DISTINCT days — "יש לי מחר ב-11:00, מחרתיים ב-14:30,
 * או ביום חמישי ב-10:00" beats three options on the same morning. Falls back to same-day slots
 * only when there aren't enough distinct days.
 */
export function pickSpread(slots: TimeSlot[], count: number): TimeSlot[] {
  const byDay = new Map<number, TimeSlot[]>();
  for (const slot of slots) {
    const day = israelDayStamp(new Date(slot.start));
    const bucket = byDay.get(day);
    if (bucket) bucket.push(slot);
    else byDay.set(day, [slot]);
  }

  const days = [...byDay.keys()].sort((a, b) => a - b);
  const picked: TimeSlot[] = [];
  for (const day of days) {
    if (picked.length >= count) break;
    picked.push(byDay.get(day)![0]!);
  }
  // Not enough distinct days — fill with the remaining slots in chronological order.
  if (picked.length < count) {
    const chosen = new Set(picked.map((s) => s.start));
    for (const slot of slots) {
      if (picked.length >= count) break;
      if (!chosen.has(slot.start)) picked.push(slot);
    }
  }
  return picked.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}
