import { describe, expect, it } from 'vitest';
import { periodBounds, periodLabel, isWithin, BILLING_TIMEZONE } from './period.js';

/**
 * WHICH MONTH A LEAD LANDS IN.
 *
 * Boring maths with an expensive failure mode: a lead placed in the wrong period is either an
 * overage charge the customer did not incur, or a unit that was never billed. Both are discovered
 * by the customer, not by us, and both cost more in trust than in shekels.
 *
 * These assertions are written in Israel wall-clock terms on purpose — that is the only frame in
 * which "your month starts on the 12th" is a true statement to a customer.
 */

/** Render an instant as Israel wall-clock, so failures read in the frame the rule is written in. */
function israel(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: BILLING_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace('T', ' ');
}

describe('periodBounds', () => {
  it('runs anchor-day midnight to anchor-day midnight', () => {
    const { start, end } = periodBounds(12, new Date('2026-08-20T09:00:00Z'));
    expect(israel(start)).toBe('2026-08-12 00:00');
    expect(israel(end)).toBe('2026-09-12 00:00');
  });

  it('before the anchor day, you are still in the period that opened LAST month', () => {
    // The 5th, on a plan anchored to the 12th: this lead belongs to the period that began on
    // 12 July. Getting this backwards shifts a whole week of leads into the wrong invoice.
    const { start, end } = periodBounds(12, new Date('2026-08-05T09:00:00Z'));
    expect(israel(start)).toBe('2026-07-12 00:00');
    expect(israel(end)).toBe('2026-08-12 00:00');
  });

  it('the anchor day itself belongs to the NEW period', () => {
    const { start } = periodBounds(12, new Date('2026-08-12T06:00:00Z'));
    expect(israel(start)).toBe('2026-08-12 00:00');
  });

  it('rolls the year over in December', () => {
    const { start, end } = periodBounds(15, new Date('2026-12-20T12:00:00Z'));
    expect(israel(start)).toBe('2026-12-15 00:00');
    expect(israel(end)).toBe('2027-01-15 00:00');
  });

  it('and backwards across the year boundary in January', () => {
    const { start, end } = periodBounds(15, new Date('2027-01-03T12:00:00Z'));
    expect(israel(start)).toBe('2026-12-15 00:00');
    expect(israel(end)).toBe('2027-01-15 00:00');
  });

  it('a lead at 00:30 Israel time on the anchor day is in the new period, not the old one', () => {
    // THE UTC BUG THIS FILE EXISTS TO PREVENT. Israel is +3 in summer, so 00:30 on 1 August local
    // is 21:30 on 31 July UTC. Computing boundaries in UTC would file this lead under July — one
    // month late, in the customer's own view of their calendar.
    const justAfterMidnight = new Date('2026-07-31T21:30:00Z');
    expect(israel(justAfterMidnight)).toBe('2026-08-01 00:30');

    const { start } = periodBounds(1, justAfterMidnight);
    expect(israel(start)).toBe('2026-08-01 00:00');
  });

  it('a lead at 23:30 Israel time on the last day is still in the OLD period', () => {
    const justBeforeMidnight = new Date('2026-07-31T20:30:00Z');
    expect(israel(justBeforeMidnight)).toBe('2026-07-31 23:30');

    const { start } = periodBounds(1, justBeforeMidnight);
    expect(israel(start)).toBe('2026-07-01 00:00');
  });

  it('survives the DST changes at both ends of the year', () => {
    // Israel springs forward in late March and falls back in late October, both at 02:00 local.
    // A period spanning a transition is 30 days plus or minus an hour — the BOUNDARIES must still
    // land on local midnight, which is the property that keeps "your month starts on the 1st" true.
    const spring = periodBounds(1, new Date('2026-03-15T12:00:00Z'));
    expect(israel(spring.start)).toBe('2026-03-01 00:00');
    expect(israel(spring.end)).toBe('2026-04-01 00:00');

    const autumn = periodBounds(1, new Date('2026-10-15T12:00:00Z'));
    expect(israel(autumn.start)).toBe('2026-10-01 00:00');
    expect(israel(autumn.end)).toBe('2026-11-01 00:00');
  });

  it('February is not special, because the anchor day can never exceed 28', () => {
    const { start, end } = periodBounds(28, new Date('2027-02-28T12:00:00Z'));
    expect(israel(start)).toBe('2027-02-28 00:00');
    expect(israel(end)).toBe('2027-03-28 00:00');
  });

  it('clamps a nonsense anchor day instead of throwing', () => {
    // Metering a lead must never fail because a bad anchor day got into a row. Refusing to bill is
    // worse than billing against a clamped boundary — and the clamp is visible in the result.
    for (const bad of [0, -3, 31, 99, NaN]) {
      const { start, end } = periodBounds(bad, new Date('2026-08-20T09:00:00Z'));
      expect(start.getTime()).toBeLessThan(end.getTime());
      expect(Number.isNaN(start.getTime())).toBe(false);
    }
    // 31 clamps to 28; the 20th is before the 28th, so we are still in the period that opened on
    // 28 July — the clamp changes the anchor, not the rule applied to it.
    expect(israel(periodBounds(31, new Date('2026-08-20T09:00:00Z')).start)).toBe('2026-07-28 00:00');
    expect(israel(periodBounds(0, new Date('2026-08-20T09:00:00Z')).start)).toBe('2026-08-01 00:00');
  });

  it('consecutive periods tile without gap or overlap', () => {
    // Half-open [start, end). If one instant belonged to two periods it would be billed twice; if
    // it belonged to none it would vanish.
    const first = periodBounds(12, new Date('2026-08-20T09:00:00Z'));
    const next = periodBounds(12, first.end);
    expect(next.start.getTime()).toBe(first.end.getTime());
    expect(isWithin(first, first.end)).toBe(false);
    expect(isWithin(next, first.end)).toBe(true);
  });
});

describe('periodLabel', () => {
  it('names a period after the month it opened in', () => {
    expect(periodLabel(periodBounds(12, new Date('2026-08-20T09:00:00Z')))).toBe('2026-08');
    expect(periodLabel(periodBounds(12, new Date('2026-08-05T09:00:00Z')))).toBe('2026-07');
  });
});
