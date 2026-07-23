/**
 * Per-tenant meeting-reminder configuration (`tenants.settings.reminders`).
 *
 * Build principles applied verbatim:
 *  - Every knob per-tenant: offsets, channels, templates — nothing hardcoded; the values below
 *    are DEFAULTS, not law.
 *  - Safety boundaries are NOT knobs: quiet hours cannot be removed (absent/degenerate config
 *    resolves to the default window) and opt-out is enforced unconditionally in the worker.
 *    `enabled: false` IS honored — reminders are a feature; opt-out and quiet hours are the law.
 */

export interface ReminderQuietHours {
  /** 'HH:MM' Israel wall-clock. The window may wrap midnight (default 21:00 → 08:00). */
  start: string;
  end: string;
}

export interface ReminderSettings {
  enabled: boolean;
  /** Minutes before the meeting; default [1440, 60] = T-24h and T-1h. */
  offsetsMinutes: number[];
  channels: Array<'whatsapp' | 'email'>;
  quietHours: ReminderQuietHours;
  /** Per-slot text overrides with {lead_name} {slot} {meet_link} {company} placeholders. */
  templateOverrides?: Partial<
    Record<'t24_whatsapp' | 't1_whatsapp' | 't24_email_subject' | 't24_email_body' | 't1_email_subject' | 't1_email_body', string>
  >;
}

export const REMINDER_DEFAULTS: ReminderSettings = {
  enabled: true,
  offsetsMinutes: [1440, 60],
  channels: ['whatsapp', 'email'],
  quietHours: { start: '21:00', end: '08:00' },
};

/**
 * Is this Israel-local minute-of-day inside the quiet window? Windows may wrap midnight —
 * the default 21:00→08:00 does. End-exclusive: at exactly 08:00 the window is over.
 */
export function inQuietWindow(minutesOfDay: number, window: ReminderQuietHours): boolean {
  const toMin = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const start = toMin(window.start);
  const end = toMin(window.end);
  return start < end
    ? minutesOfDay >= start && minutesOfDay < end
    : minutesOfDay >= start || minutesOfDay < end;
}

const MIN_OFFSET_MINUTES = 5;
const MAX_OFFSET_MINUTES = 14 * 24 * 60;
const MAX_OFFSETS = 6;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function resolveReminderSettings(settings: unknown): ReminderSettings {
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>)['reminders'] as Record<string, unknown> | undefined)
      : undefined;
  if (!raw || typeof raw !== 'object') return REMINDER_DEFAULTS;

  const enabled = raw.enabled !== false; // only an explicit false turns the feature off

  let offsetsMinutes = Array.isArray(raw.offsetsMinutes)
    ? [
        ...new Set(
          raw.offsetsMinutes
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
            .map(Math.round)
            .filter((v) => v >= MIN_OFFSET_MINUTES && v <= MAX_OFFSET_MINUTES),
        ),
      ].slice(0, MAX_OFFSETS)
    : REMINDER_DEFAULTS.offsetsMinutes;
  if (offsetsMinutes.length === 0) offsetsMinutes = REMINDER_DEFAULTS.offsetsMinutes;

  const channels = Array.isArray(raw.channels)
    ? (raw.channels.filter((c): c is 'whatsapp' | 'email' => c === 'whatsapp' || c === 'email') as Array<
        'whatsapp' | 'email'
      >)
    : REMINDER_DEFAULTS.channels;

  // Quiet hours are a safety boundary: malformed or degenerate (start===end) → the DEFAULT
  // window, never "no quiet hours".
  const qh = raw.quietHours as Record<string, unknown> | undefined;
  const start = typeof qh?.start === 'string' && HHMM.test(qh.start) ? qh.start : null;
  const end = typeof qh?.end === 'string' && HHMM.test(qh.end) ? qh.end : null;
  const quietHours =
    start && end && start !== end ? { start, end } : REMINDER_DEFAULTS.quietHours;

  const templateOverrides =
    raw.templateOverrides && typeof raw.templateOverrides === 'object'
      ? (raw.templateOverrides as ReminderSettings['templateOverrides'])
      : undefined;

  return {
    enabled,
    offsetsMinutes,
    channels: channels.length > 0 ? channels : REMINDER_DEFAULTS.channels,
    quietHours,
    ...(templateOverrides ? { templateOverrides } : {}),
  };
}
