/**
 * Operating hours guard for outbound calls.
 *
 * Calls are only allowed within the configured window (default 09:00–23:00 Israel time).
 * Saturdays and Hebrew calendar holidays are blocked automatically.
 * Tenants can override via settings.operating_hours in the DB.
 *
 * Usage in flow-executor:
 *   const delayMs = getDelayUntilNextActiveSlot(new Date(), tenantOperatingHours);
 *   if (delayMs > 0) { re-enqueue same step with delayMs; return; }
 */

export interface OperatingHoursConfig {
  /** Hour to start calls (24h, Israel time). Default: 9 */
  startHour: number;
  /** Hour to stop calls (24h, Israel time). Default: 23 */
  endHour: number;
  /** IANA timezone. Default: Asia/Jerusalem */
  timezone: string;
  /**
   * Additional blocked dates in YYYY-MM-DD format.
   * Pre-populated with Israeli public holidays for 2026–2027.
   * Tenants can extend this list via settings.operating_hours.extraHolidays.
   */
  holidays: string[];
}

/**
 * Israeli public holidays (Chagim) 2026–2027.
 * Includes Shabbat (all Saturdays are blocked separately by dayOfWeek check).
 * Eve (Erev) days are excluded — calls can still be made until the configured endHour.
 *
 * To update for future years, add dates in YYYY-MM-DD format.
 */
export const ISRAEL_HOLIDAYS: string[] = [
  // ——— 5786 (2026) ———
  // פסח — Passover
  '2026-04-02', '2026-04-03', '2026-04-08', '2026-04-09',
  // יום העצמאות — Independence Day (celebrated April 29, 2026)
  '2026-04-29',
  // שבועות — Shavuot
  '2026-05-22', '2026-05-23',
  // ראש השנה — Rosh Hashana
  '2026-09-11', '2026-09-12',
  // יום כיפור — Yom Kippur (fasting day, no calls)
  '2026-09-20',
  // סוכות — Sukkot (first + last days)
  '2026-09-25', '2026-10-02',
  // שמחת תורה — Simchat Torah
  '2026-10-03',

  // ——— 5787 (2027) ———
  // פסח — Passover
  '2027-03-23', '2027-03-24', '2027-03-29', '2027-03-30',
  // יום העצמאות — Independence Day
  '2027-04-20',
  // שבועות — Shavuot
  '2027-06-11', '2027-06-12',
  // ראש השנה — Rosh Hashana
  '2027-10-02', '2027-10-03',
  // יום כיפור — Yom Kippur
  '2027-10-11',
  // סוכות + שמחת תורה
  '2027-10-16', '2027-10-23',
];

export const DEFAULT_OPERATING_HOURS: OperatingHoursConfig = {
  startHour: 9,
  endHour: 23,
  timezone: 'Asia/Jerusalem',
  holidays: ISRAEL_HOLIDAYS,
};

/** Parse tenant's operating_hours settings overlay (partial override). */
export function resolveOperatingHours(
  tenantSettings: Record<string, any> | null,
): OperatingHoursConfig {
  const oh = tenantSettings?.operating_hours ?? {};
  const extraHolidays: string[] = oh.extraHolidays ?? [];
  return {
    startHour: oh.startHour ?? DEFAULT_OPERATING_HOURS.startHour,
    endHour: oh.endHour ?? DEFAULT_OPERATING_HOURS.endHour,
    timezone: oh.timezone ?? DEFAULT_OPERATING_HOURS.timezone,
    holidays: [...DEFAULT_OPERATING_HOURS.holidays, ...extraHolidays],
  };
}

/** Return the current wall-clock time in the given IANA timezone. */
function getZonedParts(date: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parseInt(parts.hour ?? '0', 10);
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const weekdayStr = parts.weekday ?? '';
  // en-CA short weekday: Sun Mon Tue Wed Thu Fri Sat
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayStr);
  return { hour, dateStr, dayOfWeek };
}

/** True if `date` falls within an active calling slot. */
export function isActiveSlot(date: Date, cfg: OperatingHoursConfig): boolean {
  const { hour, dateStr, dayOfWeek } = getZonedParts(date, cfg.timezone);

  // Saturday = Shabbat — always blocked
  if (dayOfWeek === 6) return false;

  // Public holiday
  if (cfg.holidays.includes(dateStr)) return false;

  // Outside business hours
  if (hour < cfg.startHour || hour >= cfg.endHour) return false;

  return true;
}

/**
 * Returns milliseconds to delay until the next active calling slot.
 * Returns 0 if `now` is already within an active slot.
 * Searches up to 14 days ahead to handle multi-day holiday runs.
 */
export function getDelayUntilNextActiveSlot(
  now: Date,
  cfg: OperatingHoursConfig,
): number {
  if (isActiveSlot(now, cfg)) return 0;

  // Step through time in 1-minute increments until we find an active slot.
  // Start at the next whole minute to avoid fractional delays.
  const MINUTE = 60_000;
  let candidate = new Date(Math.ceil(now.getTime() / MINUTE) * MINUTE);

  const limit = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  while (candidate < limit) {
    if (isActiveSlot(candidate, cfg)) {
      return candidate.getTime() - now.getTime();
    }
    // Jump ahead efficiently: if outside hours, skip to next startHour
    const { hour, dayOfWeek, dateStr } = getZonedParts(candidate, cfg.timezone);
    const isHoliday = cfg.holidays.includes(dateStr) || dayOfWeek === 6;

    if (isHoliday || hour >= cfg.endHour) {
      // Skip to 09:00 next calendar day
      candidate = nextDayAt(candidate, cfg.startHour, cfg.timezone);
    } else if (hour < cfg.startHour) {
      // Skip to today's startHour
      candidate = sameDayAt(candidate, cfg.startHour, cfg.timezone);
    } else {
      candidate = new Date(candidate.getTime() + MINUTE);
    }
  }

  // Fallback — should never happen with a 14-day window
  return 24 * 60 * 60 * 1000;
}

/** Build a Date for `hour:00` on the same calendar day as `base` in `timezone`. */
function sameDayAt(base: Date, hour: number, timezone: string): Date {
  const { dateStr } = getZonedParts(base, timezone);
  // Construct an ISO string in the local zone and convert to UTC
  const localIso = `${dateStr}T${String(hour).padStart(2, '0')}:00:00`;
  return new Date(
    new Date(localIso).getTime() - getTimezoneOffsetMs(base, timezone) +
    getTimezoneOffsetMs(new Date(localIso), timezone),
  );
}

/** Build a Date for `hour:00` on the day after `base` in `timezone`. */
function nextDayAt(base: Date, hour: number, timezone: string): Date {
  const { dateStr } = getZonedParts(base, timezone);
  const [y, m, d] = dateStr.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const localIso = `${tomorrowStr}T${String(hour).padStart(2, '0')}:00:00`;
  return new Date(
    new Date(localIso).getTime() - getTimezoneOffsetMs(base, timezone) +
    getTimezoneOffsetMs(new Date(localIso), timezone),
  );
}

/** Get the UTC offset in ms for `date` in `timezone`. */
function getTimezoneOffsetMs(date: Date, timezone: string): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: timezone });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}
