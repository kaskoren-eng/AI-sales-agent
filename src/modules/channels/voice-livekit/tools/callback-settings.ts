import {
  CALLBACK_DEFAULTS,
  CALLBACK_LADDERS,
  type CallbackDayParts,
  type CallbackKind,
  type CallbackRung,
  type CallbackRungOffset,
  type CallbackTimeOfDay,
  type CallbackWindowConfig,
} from './callback-time.js';

/**
 * PER-TENANT CALLBACK CONFIGURATION — `tenants.settings.callbacks`.
 *
 * Shaped and reasoned about exactly like `reminders`
 * (`src/modules/scheduling/reminders/reminder-settings.ts`), which is the house precedent for
 * "every knob per-tenant, except the ones that are safety boundaries":
 *
 *   A KNOB   `enabled`, `maxAttempts`, the proactive calling hours, the day-part anchors, and —
 *            since 2026-09-04 — THE SHAPE OF THE LADDER ITSELF. Koren: *"כל לקוח תהיה לו את
 *            האפשרות להחליט מה הפולואפים שהוא רוצה שהסוכן יעשה. זה חייב להיות גמיש לפי לקוח."*
 *            A gym chasing a trial signup and a B2B vendor chasing a procurement lead do not
 *            follow up on the same rhythm, and until this existed they had no choice but to.
 *
 *   NOT A KNOB, and unreachable from here by construction:
 *     · the hard floor (23:00–07:00, Saturday, Israeli holidays) — see `CallbackWindowConfig`,
 *       which deliberately has no field for it;
 *     · opt-out and every other stop signal, enforced before this is read at all;
 *     · a rung's `window`. Every tenant-authored rung is stamped `proactive`; `honored` is
 *       reachable only by a time the LEAD named. See `CallbackRung.window`.
 *     · a rung's `channel`, until the worker actually reads it. See `CallbackRung.channel`.
 *     · the ceiling on how many times a lead who is not answering may be dialled.
 *
 * ⚠️ OPEN, NOT DECIDED HERE: the proactive window ends at 20:00 while the shared `operating_hours`
 * default runs to 23:00. Those two disagree, and settling it is Koren's by ear. This file uses
 * `CALLBACK_DEFAULTS` unchanged and does not pick a side.
 */

export interface CallbackSettings extends CallbackWindowConfig {
  /** Only an explicit `false` turns callbacks off. Absent settings mean the defaults, not "off". */
  enabled: boolean;
  /** Dials, not rungs-plus-message. Clamped to 1…MAX_ATTEMPTS_CEILING. */
  maxAttempts: number;
  /** Rung 1 of the `disconnected` ladder — how soon after a dropped call we ring back. */
  disconnectedDelayMinutes: number;
  /** Anchors a `rotate` / `morning` / `afternoon` rung lands on. */
  dayParts: CallbackDayParts;
  /**
   * The tenant's own ladders, one per kind. Every kind is present after resolution — a kind the
   * tenant did not customise carries the shipped default — so the worker never has to ask whether
   * it is looking at an override.
   */
  ladders: Record<CallbackKind, readonly CallbackRung[]>;
}

export const CALLBACK_SETTINGS_DEFAULTS: CallbackSettings = {
  enabled: true,
  maxAttempts: CALLBACK_DEFAULTS.maxAttempts,
  proactiveWeekday: CALLBACK_DEFAULTS.proactiveWeekday,
  proactiveFriday: CALLBACK_DEFAULTS.proactiveFriday,
  disconnectedDelayMinutes: CALLBACK_DEFAULTS.disconnectedDelayMinutes,
  dayParts: CALLBACK_DEFAULTS.dayParts,
  ladders: { ...CALLBACK_LADDERS },
};

/**
 * The ceiling on how many times a lead who is not answering may be dialled — a boundary, not a
 * default, and it applies to `maxAttempts` and to the length of a tenant-authored ladder alike.
 *
 * Raised from 3 to 5 by Koren on 2026-09-04, when the ladder became the tenant's to define. The
 * ceiling did not become a preference: a tenant may now choose 4 or 5 follow-ups where the product
 * used to insist on at most 3, but "keep dialling until he answers" remains the one thing this
 * refuses. Stopping is still the feature; the tenant only picks where.
 */
export const MAX_ATTEMPTS_CEILING = 5;

/** The same ceiling, expressed as rungs. A ladder longer than this is truncated, not rejected. */
export const MAX_LADDER_RUNGS = MAX_ATTEMPTS_CEILING;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_DISCONNECTED_DELAY = 1;
const MAX_DISCONNECTED_DELAY = 24 * 60;
/** A rung may not sit more than 30 days out: past that a "follow-up" is a cold call. */
const MAX_OFFSET_MINUTES = 30 * 24 * 60;
const MIN_OFFSET_MINUTES = 1;
const CALLBACK_KINDS: readonly CallbackKind[] = [
  'explicit',
  'soft_defer',
  'not_reached',
  'disconnected',
];
const TIME_OF_DAY_VALUES: readonly CallbackTimeOfDay[] = ['keep', 'rotate', 'morning', 'afternoon'];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * A window is taken from the tenant only when BOTH ends parse and the range is non-empty.
 * Anything else — a typo, a half-written override, `end` before `start` — falls back to the
 * default window rather than to "no window", for the same reason quiet hours do: the failure mode
 * of a malformed setting must be a normal calling hour, never an unbounded one.
 */
function resolveWindow(
  raw: unknown,
  fallback: { start: string; end: string },
): { start: string; end: string } {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  const start = typeof obj.start === 'string' && HHMM.test(obj.start) ? obj.start : null;
  const end = typeof obj.end === 'string' && HHMM.test(obj.end) ? obj.end : null;
  if (!start || !end) return fallback;
  if (toMinutes(start) >= toMinutes(end)) return fallback;
  return { start, end };
}

/**
 * The day-part anchors. All three must parse, and morning must come before the split which must
 * come before afternoon — a "rotation" whose two halves are the same hour is not a rotation, and
 * silently keeping half of a malformed triple is worse than keeping none of it.
 */
function resolveDayParts(raw: unknown): CallbackDayParts {
  const d = CALLBACK_SETTINGS_DEFAULTS.dayParts;
  if (!raw || typeof raw !== 'object') return d;
  const obj = raw as Record<string, unknown>;
  const pick = (v: unknown): string | null => (typeof v === 'string' && HHMM.test(v) ? v : null);
  const morning = pick(obj.morning);
  const afternoon = pick(obj.afternoon);
  const split = pick(obj.split);
  if (!morning || !afternoon || !split) return d;
  if (!(toMinutes(morning) < toMinutes(split) && toMinutes(split) <= toMinutes(afternoon))) return d;
  return { morning, afternoon, split };
}

/**
 * One rung's offset, from the tenant-facing spelling: `{ minutes }`, `{ hours }` or
 * `{ businessDays }`, exactly one of them. `lead_time` is deliberately not expressible — it means
 * "the instant the lead himself named", which no ladder entry can assert on his behalf.
 */
function resolveOffset(raw: unknown): CallbackRungOffset | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && Math.round(v) > 0 ? Math.round(v) : null;

  const minutes = num(obj.minutes);
  const hours = num(obj.hours);
  const businessDays = num(obj.businessDays);
  const given = [minutes, hours, businessDays].filter((v) => v !== null);
  if (given.length !== 1) return null; // none of them, or a rung that means two things at once

  if (minutes !== null) {
    return minutes >= MIN_OFFSET_MINUTES && minutes <= MAX_OFFSET_MINUTES
      ? { unit: 'minutes', value: minutes }
      : null;
  }
  if (hours !== null) {
    return hours * 60 <= MAX_OFFSET_MINUTES ? { unit: 'hours', value: hours } : null;
  }
  // 30 days of business days is more calendar days than the cap allows; 20 is the honest bound.
  return businessDays! <= 20 ? { unit: 'business_days', value: businessDays! } : null;
}

/**
 * A tenant's ladder for one kind.
 *
 * WHOLE-LADDER FALLBACK, deliberately. One malformed rung discards the tenant's ladder and the
 * shipped default is used instead — rather than dropping that rung and running the rest. A ladder
 * silently one rung shorter than the operator wrote is the kind of wrong that nobody notices for a
 * quarter; a ladder that is visibly the default gets a support ticket the same week. Same reasoning
 * as `resolveWindow` above.
 *
 * `[]` IS VALID and means "no follow-ups of this kind" — the tenant that wants one dial and no
 * chasing. Distinguishable from a malformed value because it parses.
 *
 * THE FIRST RUNG OF `explicit` IS NOT THE TENANT'S. It is the time the LEAD named, in the honored
 * window, and it is prepended here; a tenant's `explicit` array therefore describes the RETRIES
 * after his own time went unanswered. Nobody but the lead gets to place rung 1 of his own callback.
 */
function resolveLadder(raw: unknown, kind: CallbackKind): readonly CallbackRung[] {
  const fallback = CALLBACK_LADDERS[kind];
  if (!Array.isArray(raw)) return fallback;
  if (raw.length > MAX_LADDER_RUNGS) return fallback;

  const leadRung = kind === 'explicit' ? CALLBACK_LADDERS.explicit[0]! : null;
  const out: CallbackRung[] = leadRung ? [leadRung] : [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return fallback;
    const obj = entry as Record<string, unknown>;
    const offset = resolveOffset(obj.after);
    if (!offset) return fallback;

    const timeOfDay =
      obj.timeOfDay === undefined || obj.timeOfDay === null
        ? 'keep'
        : TIME_OF_DAY_VALUES.includes(obj.timeOfDay as CallbackTimeOfDay)
          ? (obj.timeOfDay as CallbackTimeOfDay)
          : null;
    if (timeOfDay === null) return fallback;

    out.push({
      rung: out.length + 1,
      offset,
      // Not read from the tenant. See `CallbackRung.window` — `honored` belongs to the lead alone.
      window: 'proactive',
      // Not read from the tenant either, and not a union yet. See `CallbackRung.channel`.
      channel: 'call',
      timeOfDay,
    });
  }

  // The prepended lead rung must not let an `explicit` ladder sneak past the ceiling.
  return out.length > MAX_LADDER_RUNGS ? fallback : out;
}

function resolveLadders(raw: unknown): Record<CallbackKind, readonly CallbackRung[]> {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<CallbackKind, readonly CallbackRung[]>;
  for (const kind of CALLBACK_KINDS) {
    out[kind] = resolveLadder(obj[kind], kind);
  }
  return out;
}

export function resolveCallbackSettings(settings: unknown): CallbackSettings {
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>)['callbacks'] as Record<string, unknown> | undefined)
      : undefined;
  if (!raw || typeof raw !== 'object') return CALLBACK_SETTINGS_DEFAULTS;

  const enabled = raw.enabled !== false;

  const maxAttempts =
    typeof raw.maxAttempts === 'number' && Number.isFinite(raw.maxAttempts)
      ? Math.min(MAX_ATTEMPTS_CEILING, Math.max(1, Math.round(raw.maxAttempts)))
      : CALLBACK_SETTINGS_DEFAULTS.maxAttempts;

  const disconnectedDelayMinutes =
    typeof raw.disconnectedDelayMinutes === 'number' && Number.isFinite(raw.disconnectedDelayMinutes)
      ? Math.min(
          MAX_DISCONNECTED_DELAY,
          Math.max(MIN_DISCONNECTED_DELAY, Math.round(raw.disconnectedDelayMinutes)),
        )
      : CALLBACK_SETTINGS_DEFAULTS.disconnectedDelayMinutes;

  return {
    enabled,
    maxAttempts,
    disconnectedDelayMinutes,
    proactiveWeekday: resolveWindow(raw.proactiveWeekday, CALLBACK_SETTINGS_DEFAULTS.proactiveWeekday),
    proactiveFriday: resolveWindow(raw.proactiveFriday, CALLBACK_SETTINGS_DEFAULTS.proactiveFriday),
    dayParts: resolveDayParts(raw.dayParts),
    ladders: resolveLadders(raw.ladders),
  };
}
