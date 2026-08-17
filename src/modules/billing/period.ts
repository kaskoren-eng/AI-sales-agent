/**
 * WHICH BILLING MONTH A THING FELL IN.
 *
 * Pure, total, no I/O — because every other part of billing depends on it agreeing with itself.
 * If `periodBounds` returns one answer when a lead is metered and a different answer when the
 * invoice is written, units land in the wrong month and the customer is charged overage they
 * didn't incur.
 *
 * Boundaries are ANCHOR-DAY MIDNIGHT IN ISRAEL, not UTC. A customer whose period turns over on the
 * 1st expects a lead at 01:00 on the 1st to be in the new month; in UTC (Israel is +2/+3) it would
 * land in the old one. That is a small error that is impossible to explain on a phone call.
 *
 * `Intl.DateTimeFormat` rather than a date library, matching `src/shared/operating-hours.ts` — the
 * offset is derived from the platform's own tz database, which tracks Israel's DST rules without
 * this file having to know them.
 */

export const BILLING_TIMEZONE = 'Asia/Jerusalem';

export interface PeriodBounds {
  /** Inclusive. */
  start: Date;
  /** EXCLUSIVE — periods are half-open [start, end), so consecutive periods can't both claim an instant. */
  end: Date;
}

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BILLING_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** The wall-clock civil date in Israel at a given instant. */
function zonedParts(at: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(partsFormatter.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // `hour12: false` renders midnight as 24 in some ICU versions. Normalising here rather than at
    // each call site, because the one place it matters is the exact boundary this file computes.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far ahead of UTC Israel is at a given instant, in ms. Positive (+2h winter, +3h summer). */
function offsetMsAt(instant: Date): number {
  const p = zonedParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of midnight on a given civil date in Israel.
 *
 * Two passes because the offset depends on the instant we are trying to find. The refinement is
 * enough — and unambiguous — because Israel's DST transitions happen at 02:00 local, so MIDNIGHT
 * never falls in a skipped hour or a repeated one. A clock change at midnight would make some
 * anchor days genuinely ambiguous; this one does not, which is why the anchor is a date and not a
 * time of day.
 */
function israelMidnightUtc(year: number, month: number, day: number): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstGuess = new Date(naive - offsetMsAt(new Date(naive)));
  const refined = new Date(naive - offsetMsAt(firstGuess));
  return refined;
}

/** Step a (year, month) pair by ±1 month, keeping month in 1..12. */
function addMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/**
 * The billing period containing `at`, for a tenant whose period turns over on `anchorDay`.
 *
 * `anchorDay` is constrained to 1..28 by a CHECK on `tenants` — see the column comment. This
 * function CLAMPS anything outside that range rather than throwing: metering a lead must never
 * fail because a bad anchor day got into a row somehow. Refusing to bill is worse than billing
 * against a slightly wrong boundary, and the clamp is visible in the returned bounds.
 */
export function periodBounds(anchorDay: number, at: Date = new Date()): PeriodBounds {
  const anchor = Math.min(28, Math.max(1, Math.floor(anchorDay) || 1));
  const { year, month, day } = zonedParts(at);

  // Before the anchor day, we are still inside the period that opened LAST month.
  const startYm = day >= anchor ? { year, month } : addMonth(year, month, -1);
  const endYm = addMonth(startYm.year, startYm.month, 1);

  return {
    start: israelMidnightUtc(startYm.year, startYm.month, anchor),
    end: israelMidnightUtc(endYm.year, endYm.month, anchor),
  };
}

/** A stable label for a period — `2026-08` style, from the START of the period. Display only. */
export function periodLabel(bounds: PeriodBounds): string {
  const p = zonedParts(bounds.start);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** True when `at` falls inside the half-open period. The boundary belongs to the NEXT period. */
export function isWithin(bounds: PeriodBounds, at: Date): boolean {
  return at.getTime() >= bounds.start.getTime() && at.getTime() < bounds.end.getTime();
}
