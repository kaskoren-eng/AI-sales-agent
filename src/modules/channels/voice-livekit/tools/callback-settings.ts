import { CALLBACK_DEFAULTS, type CallbackWindowConfig } from './callback-time.js';

/**
 * PER-TENANT CALLBACK CONFIGURATION — `tenants.settings.callbacks`.
 *
 * Shaped and reasoned about exactly like `reminders`
 * (`src/modules/scheduling/reminders/reminder-settings.ts`), which is the house precedent for
 * "every knob per-tenant, except the ones that are safety boundaries":
 *
 *   A KNOB   `enabled`, `maxAttempts`, and the proactive calling hours. A business that only wants
 *            to ring people back between 10:00 and 17:00 is making a legitimate choice.
 *
 *   NOT A KNOB, and unreachable from here by construction:
 *     · the hard floor (23:00–07:00, Saturday, Israeli holidays) — see `CallbackWindowConfig`,
 *       which deliberately has no field for it;
 *     · opt-out, which the worker enforces before it reads this at all;
 *     · the ladder's shape. `maxAttempts` can only ever SHORTEN it (1…3) — a tenant cannot
 *       dial a lead who did not answer a fourth time. Stopping is the feature.
 *
 * The defaults are the fixed numbers Koren asked for on 2026-09-01. The namespace exists because
 * this is a multi-tenant product, not because the numbers are an open question.
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
}

export const CALLBACK_SETTINGS_DEFAULTS: CallbackSettings = {
  enabled: true,
  maxAttempts: CALLBACK_DEFAULTS.maxAttempts,
  proactiveWeekday: CALLBACK_DEFAULTS.proactiveWeekday,
  proactiveFriday: CALLBACK_DEFAULTS.proactiveFriday,
  disconnectedDelayMinutes: CALLBACK_DEFAULTS.disconnectedDelayMinutes,
};

/**
 * The ceiling on `maxAttempts`, and it is a boundary rather than a default. §7: "a lead who did
 * not answer three times must not be dialled a fourth." A tenant may ask for fewer; asking for
 * more is the one thing this feature exists to refuse.
 */
export const MAX_ATTEMPTS_CEILING = CALLBACK_DEFAULTS.maxAttempts;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_DISCONNECTED_DELAY = 1;
const MAX_DISCONNECTED_DELAY = 24 * 60;

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
  };
}
