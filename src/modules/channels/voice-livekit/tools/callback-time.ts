import {
  israelDayKey,
  israelMinutesOfDay,
  nextIsraelClockTime,
  startOfIsraelDay,
} from './israel-time.js';
import { ISRAEL_HOLIDAYS } from '../../../../shared/operating-hours.js';

/**
 * WHEN DO WE ACTUALLY RING HIM BACK.
 *
 * Design: `docs/phase-8-callback-and-followup-model.md` §3 (resolution), §4 (windows), §7 (ladder).
 *
 * Two jobs, both pure:
 *
 *   1. `resolveCallbackDueAt` turns the model's STRUCTURED intent ("in_minutes: 60", "tomorrow at
 *      16:00") into an absolute instant. The model is deliberately never asked for a timestamp:
 *      `book_meeting` never lets it do date arithmetic either — it echoes back verbatim what
 *      `check_calendar_availability` printed. A callback has no availability list, so the
 *      equivalent safety is a structured intent that CODE resolves. gpt-5.4 converting "מחר
 *      בארבע" into an Asia/Jerusalem instant across a DST boundary, without reliably knowing what
 *      "now" is, is a class of bug whose symptom is a phone ringing at 04:00 and which is
 *      invisible to every test we have.
 *
 *   2. `clampToWindow` moves that instant to a time it is decent to ring somebody, and — this is
 *      the part that matters — says WHY it moved, so the agent can tell the lead the truth instead
 *      of reading back a time she is not going to honour.
 *
 * NO I/O, NO `Date.now()` INSIDE THE LOGIC. `now` is always a parameter, exactly as in
 * `israel-time.ts`, so the tests can pin exact instants in both Israeli clock regimes (IST, UTC+2,
 * winter; IDT, UTC+3, summer) and across the transitions between them.
 *
 * Everything Israel-calendar-shaped is borrowed, never re-implemented: `israelDayKey` /
 * `israelMinutesOfDay` / `startOfIsraelDay` from `israel-time.ts`, and the holiday list from
 * `shared/operating-hours.ts`. A second copy of the Israeli holiday dates is a bug waiting for
 * the year one of them is updated and the other is not.
 */

/** Re-exported so a caller needs one import for "what timezone is all this in". */
export { BOOKING_TIMEZONE } from './israel-time.js';

// ─────────────────────────────────────────────────────────────────────────────
// The intent, as the tool schema will hand it over
// ─────────────────────────────────────────────────────────────────────────────

export type CallbackWhenKind = 'in_minutes' | 'at_time' | 'unspecified';

export const CALLBACK_DAYS = [
  'today',
  'tomorrow',
  'day_after',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
] as const;

export type CallbackDay = (typeof CALLBACK_DAYS)[number];

/**
 * Every optional field is nullable as well as optional, matching the tool schema: gpt-5.4 fills a
 * tool call's unknown fields with an explicit `null` rather than omitting them.
 */
export interface CallbackIntent {
  when_kind: CallbackWhenKind;
  in_minutes?: number | null;
  day?: CallbackDay | null;
  time_hhmm?: string | null;
}

/** How the intent was read. Useful in logs, and it is what the read-back line is built from. */
export type CallbackBasis = 'in_minutes' | 'clock_time' | 'day_and_time' | 'ladder_default';

/**
 * A documented fallback fired because the intent was incomplete or out of range. These are not
 * errors — the resolver never throws, because throwing here means Zod-shaped silence on a live
 * call — but the caller should log them: a fallback firing often means the prompt is unclear.
 */
export type CallbackResolveFallback =
  | 'missing_minutes'
  | 'minutes_clamped'
  | 'missing_time'
  | 'malformed_time'
  | 'day_already_past';

export interface ResolvedCallbackTime {
  dueAt: Date;
  basis: CallbackBasis;
  fallbacks: CallbackResolveFallback[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The ladder — §7, as DATA. Nothing here executes; the worker reads it.
// ─────────────────────────────────────────────────────────────────────────────

export type CallbackKind = 'explicit' | 'soft_defer' | 'not_reached' | 'disconnected';

export type CallbackWindow = 'honored' | 'proactive';

/** How far a rung sits from its predecessor (rung 1 of an explicit callback: the lead's own time). */
export type CallbackRungOffset =
  | { unit: 'lead_time' }
  | { unit: 'minutes'; value: number }
  | { unit: 'hours'; value: number }
  | { unit: 'business_days'; value: number };

export interface CallbackRung {
  /** 1-based, matching the `attempt` column once the dial has been made. */
  rung: number;
  offset: CallbackRungOffset;
  window: CallbackWindow;
  channel: 'call';
}

/**
 * A — the lead named a time. Rung 1 is his, honoured to the letter including 22:00. Rungs 2 and 3
 * fall back to the proactive window, because he asked for 22:00 once — he did not ask for 22:00
 * three nights running.
 */
export const CALLBACK_LADDER_EXPLICIT: readonly CallbackRung[] = [
  { rung: 1, offset: { unit: 'lead_time' }, window: 'honored', channel: 'call' },
  { rung: 2, offset: { unit: 'minutes', value: 45 }, window: 'proactive', channel: 'call' },
  { rung: 3, offset: { unit: 'business_days', value: 1 }, window: 'proactive', channel: 'call' },
];

/** B — "לא עכשיו", no time given. Nobody chose these instants, so all three are proactive. */
export const CALLBACK_LADDER_SOFT_DEFER: readonly CallbackRung[] = [
  { rung: 1, offset: { unit: 'hours', value: 3 }, window: 'proactive', channel: 'call' },
  { rung: 2, offset: { unit: 'business_days', value: 1 }, window: 'proactive', channel: 'call' },
  { rung: 3, offset: { unit: 'business_days', value: 3 }, window: 'proactive', channel: 'call' },
];

/**
 * C — not reached (rang out, voicemail, ended on the silence reflex) enters the soft-defer ladder
 * at rung 1. `disconnected` (a live call that dropped mid-conversation) is owned by a separate
 * task; it is mapped here so no caller has to invent a ladder, and that task may override it.
 */
export const CALLBACK_LADDERS: Readonly<Record<CallbackKind, readonly CallbackRung[]>> = {
  explicit: CALLBACK_LADDER_EXPLICIT,
  soft_defer: CALLBACK_LADDER_SOFT_DEFER,
  not_reached: CALLBACK_LADDER_SOFT_DEFER,
  disconnected: CALLBACK_LADDER_SOFT_DEFER,
};

export interface CallbackDefaults {
  /** Dials, not rungs-plus-message. After this many the state becomes `exhausted`. */
  maxAttempts: number;
  /** Proactive window, Sunday–Thursday, Israel local wall clock. */
  proactiveWeekday: { start: string; end: string };
  /** Proactive window, Friday — the Israeli short day. */
  proactiveFriday: { start: string; end: string };
  /**
   * The hard floor. NOT A KNOB, and no tenant setting overrides it: never between these hours,
   * never on a Saturday, never on an Israeli holiday. Same class of rule as opt-out.
   */
  hardFloor: { earliest: string; latest: string };
  /** What `at_time` means when a day was named but no hour was. */
  defaultTimeHhmm: string;
  /** Bounds on `in_minutes`, mirroring the tool schema (5 minutes … 14 days). */
  minInMinutes: number;
  maxInMinutes: number;
  /** After the last rung: one message, then the lead is left alone. */
  finalMessageChannel: 'whatsapp';
  ladders: typeof CALLBACK_LADDERS;
}

/**
 * Shaped like `REMINDER_DEFAULTS`. These are the fixed numbers Koren asked for on 2026-09-01; a
 * `tenants.settings.callbacks` namespace exists to override them because this is a multi-tenant
 * product, not because the numbers are an open question.
 */
export const CALLBACK_DEFAULTS: CallbackDefaults = {
  maxAttempts: 3,
  proactiveWeekday: { start: '09:00', end: '20:00' },
  proactiveFriday: { start: '09:00', end: '13:00' },
  hardFloor: { earliest: '07:00', latest: '23:00' },
  defaultTimeHhmm: '10:00',
  minInMinutes: 5,
  maxInMinutes: 14 * 24 * 60,
  finalMessageChannel: 'whatsapp',
  ladders: CALLBACK_LADDERS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Israel calendar helpers, built on israel-time.ts — no second Intl formatter
// ─────────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm: string): number {
  const m = HHMM_RE.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 0 = Sunday … 6 = Saturday, in Israel local time. Derived from the exported day key. */
function israelWeekday(instant: Date): number {
  return new Date(`${israelDayKey(instant)}T00:00:00.000Z`).getUTCDay();
}

function isIsraelHoliday(instant: Date): boolean {
  return ISRAEL_HOLIDAYS.includes(israelDayKey(instant));
}

/**
 * Israel-local midnight, `dayOffset` calendar days from `base`'s Israel day.
 *
 * The offset is applied via a NOON anchor rather than by adding days to midnight: an Israeli DST
 * day is 23 or 25 hours long, so midnight + 24h can land on the wrong calendar date, while
 * noon ± 1h never leaves its own day.
 */
function israelDayAnchor(base: Date, dayOffset: number): Date {
  const noonish = new Date(startOfIsraelDay(base).getTime() + dayOffset * DAY_MS + 12 * 60 * MINUTE_MS);
  return startOfIsraelDay(noonish);
}

/**
 * The instant at which Israeli wall clocks read `minutesOfDay` on the day `dayOffset` days from
 * `base`'s Israel day. Same two-pass offset correction as `nextIsraelClockTime`, so it is DST-safe.
 *
 * EXPORTED FOR ITS TESTS, deliberately. This is the arithmetic every other function here rests on,
 * and the correction pass is NOT reachable through `clampToWindow`: `startOfIsraelDay` is an hour
 * out on both 2026 transition days (it returns 23:00 the previous day on 2026-03-27 and 01:00 on
 * 2026-10-25), and that error cancels exactly against the 23- or 25-hour day for any target after
 * the transition — which every window hour in this module is, since none is earlier than 07:00.
 * A mutation test confirmed it: disabling the correction loop left all of the window tests green.
 * So it is pinned directly here rather than left as a safety net nobody has ever seen work.
 *
 * On a spring-forward day the hour 02:00–02:59 does not exist; the two passes then converge on the
 * nearest real instant rather than looping.
 */
export function israelInstantAt(base: Date, dayOffset: number, minutesOfDay: number): Date {
  let candidate = new Date(israelDayAnchor(base, dayOffset).getTime() + minutesOfDay * MINUTE_MS);
  for (let pass = 0; pass < 2; pass += 1) {
    let diff = israelMinutesOfDay(candidate) - minutesOfDay;
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    if (diff === 0) break;
    candidate = new Date(candidate.getTime() - diff * MINUTE_MS);
  }
  return candidate;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Resolution — §3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a structured callback intent into an absolute instant, in Israel local time.
 *
 * This is the RAW request. It has not been through the calling windows yet — pass the result to
 * `clampToWindow` before promising it to anybody or writing it to `callbacks.due_at`.
 *
 * Never throws. An intent that is incomplete or out of range falls back to a documented,
 * conservative reading and reports which fallback fired.
 */
export function resolveCallbackDueAt(intent: CallbackIntent, now: Date): ResolvedCallbackTime {
  const fallbacks: CallbackResolveFallback[] = [];

  if (intent.when_kind === 'in_minutes') {
    const raw = intent.in_minutes;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      fallbacks.push('missing_minutes');
      return { ...softDeferRungOne(now), fallbacks };
    }
    const clamped = Math.min(
      CALLBACK_DEFAULTS.maxInMinutes,
      Math.max(CALLBACK_DEFAULTS.minInMinutes, Math.round(raw)),
    );
    if (clamped !== Math.round(raw)) fallbacks.push('minutes_clamped');
    return { dueAt: new Date(now.getTime() + clamped * MINUTE_MS), basis: 'in_minutes', fallbacks };
  }

  if (intent.when_kind === 'at_time') {
    let hhmm = intent.time_hhmm ?? null;
    if (hhmm !== null && !HHMM_RE.test(hhmm)) {
      fallbacks.push('malformed_time');
      hhmm = null;
    }
    if (hhmm === null) {
      // A day with no hour is still usable ("מחר" → tomorrow morning). Neither is not: fall all
      // the way back to the soft-defer ladder rather than inventing both halves of an answer.
      if (!intent.day) {
        fallbacks.push('missing_time');
        return { ...softDeferRungOne(now), fallbacks };
      }
      fallbacks.push('missing_time');
      hhmm = CALLBACK_DEFAULTS.defaultTimeHhmm;
    }

    // No day named: "at 16:00" means the next time the clock reads 16:00. Already DST-safe with a
    // midnight-wrap guard, so it is reused verbatim rather than reimplemented.
    if (!intent.day) {
      return { dueAt: nextIsraelClockTime(now, hhmm), basis: 'clock_time', fallbacks };
    }

    const minutes = minutesOf(hhmm);
    let dayOffset: number;
    if (intent.day === 'today') dayOffset = 0;
    else if (intent.day === 'tomorrow') dayOffset = 1;
    else if (intent.day === 'day_after') dayOffset = 2;
    else {
      const target = WEEKDAY_INDEX[intent.day] ?? 0;
      dayOffset = (target - israelWeekday(now) + 7) % 7;
    }

    let dueAt = israelInstantAt(now, dayOffset, minutes);
    if (dueAt.getTime() <= now.getTime()) {
      // "today at 16:00" said at 17:00, or "Tuesday" said on a Tuesday afternoon. Roll forward to
      // the next honest occurrence rather than scheduling a dial in the past — the window clamp
      // would otherwise silently pull it to "now" and ring him mid-sentence.
      fallbacks.push('day_already_past');
      // 'today' rolls to tomorrow; a named weekday rolls a whole week. 'tomorrow'/'day_after'
      // cannot be in the past, so their branch is unreachable and harmless.
      const rollDays = intent.day === 'today' ? 1 : 7;
      dueAt = israelInstantAt(now, dayOffset + rollDays, minutes);
    }
    return { dueAt, basis: 'day_and_time', fallbacks };
  }

  // 'unspecified' — he deferred without naming a time. Rung 1 of the soft-defer ladder.
  return { ...softDeferRungOne(now), fallbacks };
}

/** Rung 1 of the soft-defer ladder, read from the exported defaults so there is one source. */
function softDeferRungOne(now: Date): { dueAt: Date; basis: CallbackBasis } {
  const rung = CALLBACK_LADDER_SOFT_DEFER[0]!;
  const hours = rung.offset.unit === 'hours' ? rung.offset.value : 3;
  return { dueAt: new Date(now.getTime() + hours * 60 * MINUTE_MS), basis: 'ladder_default' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Windows — §4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why the instant moved. Each value is a rule a human can be told about, because the point of
 * returning them is that the agent reads back the time she will ACTUALLY dial.
 */
export type CallbackClampReason =
  /** The request was already in the past by the time we resolved it. */
  | 'in_past'
  /** Pushed out of the 23:00–07:00 hard floor. Reachable only in the honored window. */
  | 'night_floor'
  /** Pushed into Sun–Thu 09:00–20:00 / Fri 09:00–13:00. Subsumes the night floor. */
  | 'proactive_window'
  | 'shabbat'
  | 'holiday'
  /** Should be unreachable — see MAX_ADVANCE_DAYS. Its presence means the result is NOT clamped. */
  | 'unclamped';

export interface CallbackWindowContext {
  /** Did the lead name this time himself? */
  requestedByLead: boolean;
  /** Which dial this is. Rung 1 of an explicit request is the only honoured one. */
  attempt: number;
}

export interface ClampedCallbackTime {
  /** The instant we will actually dial. This — not the raw request — is what she reads back. */
  dueAt: Date;
  window: CallbackWindow;
  moved: boolean;
  /** Every rule that pushed it, in the order applied, de-duplicated. Empty when nothing moved. */
  reasons: CallbackClampReason[];
}

/**
 * Three weeks is far past any real case — Saturday costs one day, the longest holiday run in
 * `ISRAEL_HOLIDAYS` is two — and it makes the loop provably terminating.
 */
const MAX_ADVANCE_DAYS = 21;

/**
 * `attempt` counts dials made, so a freshly inserted row is 0 and the first dial is 1. Both mean
 * "rung 1", which is the rung the honored window covers.
 *
 * ⚠️ The design doc says "attempt 1 of an explicit request" without saying whether the column is
 * 0-based or 1-based at the moment of the check. Treating 0 and 1 alike is the reading that makes
 * the promised behaviour work in both orders — clamping before the insert, and clamping again
 * before the first dial.
 */
function windowFor(ctx: CallbackWindowContext): CallbackWindow {
  return ctx.requestedByLead && ctx.attempt <= 1 ? 'honored' : 'proactive';
}

/** The allowed minute range on a given Israel weekday, or null if the whole day is closed. */
function allowedMinutes(weekday: number, window: CallbackWindow): { from: number; to: number } | null {
  if (weekday === 6) return null; // Saturday — hard floor, never overridden
  if (window === 'honored') {
    return {
      from: minutesOf(CALLBACK_DEFAULTS.hardFloor.earliest),
      to: minutesOf(CALLBACK_DEFAULTS.hardFloor.latest),
    };
  }
  const cfg = weekday === 5 ? CALLBACK_DEFAULTS.proactiveFriday : CALLBACK_DEFAULTS.proactiveWeekday;
  return { from: minutesOf(cfg.start), to: minutesOf(cfg.end) };
}

/**
 * Move `dueAt` to a time it is decent to ring somebody, and say why it moved.
 *
 * Two windows, and `requestedByLead` decides which applies (Koren, 2026-09-01: *"שילוב של חלון רחב
 * וגם מה שהלקוח מבקש — אם הוא מבקש שיחה בשעה 22:00 אז יקבל"*):
 *
 *   HONORED    attempt 1 of a time the lead named — whatever he said, subject only to the floor.
 *   PROACTIVE  soft defers, not-reached, and every retry — Sun–Thu 09:00–20:00 · Fri 09:00–13:00.
 *   HARD FLOOR always, no setting overrides — never 23:00–07:00, never Saturday, never a holiday.
 *
 * A callback is never DROPPED for landing outside its window, only deferred: the returned instant
 * is always in the future and always inside the applicable window.
 */
export function clampToWindow(
  dueAt: Date,
  ctx: CallbackWindowContext,
  now: Date,
): ClampedCallbackTime {
  const window = windowFor(ctx);
  const reasons: CallbackClampReason[] = [];
  const note = (r: CallbackClampReason): void => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const hourReason: CallbackClampReason = window === 'honored' ? 'night_floor' : 'proactive_window';

  let candidate = dueAt;
  if (candidate.getTime() < now.getTime()) {
    candidate = now;
    note('in_past');
  }

  for (let dayOffset = 0; dayOffset <= MAX_ADVANCE_DAYS; dayOffset += 1) {
    // Probe at noon so the weekday/holiday questions are asked about the DAY, never about an
    // instant that a DST shift could have nudged across a midnight.
    const probe = dayOffset === 0 ? candidate : israelInstantAt(candidate, dayOffset, 12 * 60);
    const weekday = israelWeekday(probe);

    if (weekday === 6) {
      note('shabbat');
      continue;
    }
    if (isIsraelHoliday(probe)) {
      note('holiday');
      continue;
    }
    // Non-null: allowedMinutes returns null only for Saturday, handled immediately above.
    const range = allowedMinutes(weekday, window)!;

    if (dayOffset === 0) {
      const mins = israelMinutesOfDay(candidate);
      if (mins >= range.from && mins < range.to) {
        return { dueAt: candidate, window, moved: reasons.length > 0, reasons };
      }
      note(hourReason);
      if (mins < range.from) {
        return { dueAt: israelInstantAt(candidate, 0, range.from), window, moved: true, reasons };
      }
      continue; // past today's window — try tomorrow
    }

    const movedTo = israelInstantAt(candidate, dayOffset, range.from);
    return { dueAt: movedTo, window, moved: true, reasons };
  }

  // Unreachable: Saturday costs one day and no holiday run comes close to three weeks. If it ever
  // fires, the caller gets an UNCLAMPED instant and a reason saying so — loudly wrong beats
  // quietly dialling at 04:00.
  note('unclamped');
  return { dueAt: candidate, window, moved: reasons.length > 0, reasons };
}

/**
 * Both halves in one call, which is how every caller will want it: resolve the model's intent,
 * then clamp it to the window that applies.
 */
export function planCallbackTime(
  intent: CallbackIntent,
  ctx: CallbackWindowContext,
  now: Date,
): ResolvedCallbackTime & ClampedCallbackTime {
  const resolved = resolveCallbackDueAt(intent, now);
  const clamped = clampToWindow(resolved.dueAt, ctx, now);
  return { ...resolved, ...clamped };
}
