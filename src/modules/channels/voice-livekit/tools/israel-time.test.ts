import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEETING_MINUTES,
  filterBusinessHours,
  formatSlotHe,
  isBusinessHours,
  pickSpread,
} from './israel-time.js';

/**
 * Every instant here is pinned, in BOTH Israeli clock regimes:
 *   July 2026  = IDT, UTC+3 (2026-07-21T08:00Z is 11:00 in Tel Aviv)
 *   Jan  2026  = IST, UTC+2 (2026-01-13T09:00Z is 11:00 in Tel Aviv)
 * If these fail with garbled month names, the runtime is a slim-ICU Node build — the agent
 * cannot run on it either, so the failure is the point.
 */

describe('formatSlotHe', () => {
  it('formats a July (IDT, UTC+3) slot with full Hebrew weekday and date', () => {
    // Tuesday 2026-07-21 11:00 Israel; "now" is far away so no relative prefix.
    expect(formatSlotHe('2026-07-21T08:00:00.000Z', new Date('2026-07-01T10:00:00Z'))).toBe(
      'יום שלישי, 21 ביולי, בשעה 11:00',
    );
  });

  it('formats a January (IST, UTC+2) slot — the +2 offset must hold in winter', () => {
    // Tuesday 2026-01-13 11:00 Israel.
    expect(formatSlotHe('2026-01-13T09:00:00.000Z', new Date('2026-01-01T10:00:00Z'))).toBe(
      'יום שלישי, 13 בינואר, בשעה 11:00',
    );
  });

  it('says מחר for the next Israel-local calendar day', () => {
    expect(formatSlotHe('2026-07-21T08:00:00.000Z', new Date('2026-07-20T12:00:00Z'))).toBe(
      'מחר, יום שלישי, 21 ביולי, בשעה 11:00',
    );
  });

  it('says מחרתיים two Israel-local days out', () => {
    expect(formatSlotHe('2026-07-21T08:00:00.000Z', new Date('2026-07-19T12:00:00Z'))).toBe(
      'מחרתיים, יום שלישי, 21 ביולי, בשעה 11:00',
    );
  });

  it('rolls היום/מחר on the ISRAEL midnight, not the UTC one', () => {
    // 21:30 UTC on the 20th is ALREADY 00:30 on the 21st in Israel — a slot later that same
    // Israeli day is "היום", even though UTC still thinks it's tomorrow.
    expect(formatSlotHe('2026-07-21T08:00:00.000Z', new Date('2026-07-20T21:30:00Z'))).toBe(
      'היום, יום שלישי, 21 ביולי, בשעה 11:00',
    );
  });
});

describe('isBusinessHours (Sun–Thu 09:00–17:00 Israel)', () => {
  it('accepts a Sunday mid-morning slot — the Israeli work week starts on Sunday', () => {
    // Sunday 2026-07-19 10:00 Israel.
    expect(isBusinessHours('2026-07-19T07:00:00.000Z', 15)).toBe(true);
  });

  it('rejects Friday — the provider grid generates it, the filter must kill it', () => {
    // Friday 2026-07-17 10:00 Israel.
    expect(isBusinessHours('2026-07-17T07:00:00.000Z', 15)).toBe(false);
  });

  it('rejects Saturday', () => {
    // Saturday 2026-07-18 10:00 Israel.
    expect(isBusinessHours('2026-07-18T07:00:00.000Z', 15)).toBe(false);
  });

  it('rejects 08:45 — before opening', () => {
    expect(isBusinessHours('2026-07-19T05:45:00.000Z', 15)).toBe(false);
  });

  it('accepts 09:00 exactly', () => {
    expect(isBusinessHours('2026-07-19T06:00:00.000Z', 15)).toBe(true);
  });

  it('rejects a slot that ENDS after 17:00 — 16:50 + 15min = 17:05', () => {
    expect(isBusinessHours('2026-07-19T13:50:00.000Z', 15)).toBe(false);
  });

  it('accepts a slot that ends at 17:00 exactly — 16:45 + 15min', () => {
    expect(isBusinessHours('2026-07-19T13:45:00.000Z', 15)).toBe(true);
  });

  it('holds in winter (IST, UTC+2): 10:00 Israel is 08:00 UTC, still inside hours', () => {
    // Tuesday 2026-01-13.
    expect(isBusinessHours('2026-01-13T08:00:00.000Z', DEFAULT_MEETING_MINUTES)).toBe(true);
    // Same UTC hour in July would be 11:00 Israel; in January 17:30-ending slots must fail:
    expect(isBusinessHours('2026-01-13T15:00:00.000Z', 15)).toBe(false); // 17:00 start
  });
});

describe('filterBusinessHours', () => {
  it('drops Friday/Saturday/after-hours slots and keeps the legal ones', () => {
    const mk = (start: string) => ({ start, end: start });
    const kept = filterBusinessHours(
      [
        mk('2026-07-17T07:00:00.000Z'), // Friday — out
        mk('2026-07-18T07:00:00.000Z'), // Saturday — out
        mk('2026-07-19T07:00:00.000Z'), // Sunday 10:00 — in
        mk('2026-07-19T15:00:00.000Z'), // Sunday 18:00 — out
        mk('2026-07-20T11:00:00.000Z'), // Monday 14:00 — in
      ],
      15,
    );
    expect(kept.map((s) => s.start)).toEqual([
      '2026-07-19T07:00:00.000Z',
      '2026-07-20T11:00:00.000Z',
    ]);
  });
});

describe('pickSpread', () => {
  const mk = (start: string) => ({ start, end: start });

  it('prefers distinct days over same-day slots', () => {
    const picked = pickSpread(
      [
        mk('2026-07-19T07:00:00.000Z'), // Sun 10:00
        mk('2026-07-19T08:00:00.000Z'), // Sun 11:00
        mk('2026-07-20T07:00:00.000Z'), // Mon 10:00
        mk('2026-07-21T07:00:00.000Z'), // Tue 10:00
      ],
      3,
    );
    expect(picked.map((s) => s.start)).toEqual([
      '2026-07-19T07:00:00.000Z',
      '2026-07-20T07:00:00.000Z',
      '2026-07-21T07:00:00.000Z',
    ]);
  });

  it('falls back to same-day slots when there are not enough days', () => {
    const picked = pickSpread(
      [mk('2026-07-19T07:00:00.000Z'), mk('2026-07-19T08:00:00.000Z')],
      3,
    );
    expect(picked).toHaveLength(2);
  });

  it('returns chronological order', () => {
    const picked = pickSpread(
      [mk('2026-07-21T07:00:00.000Z'), mk('2026-07-19T07:00:00.000Z')],
      2,
    );
    expect(picked.map((s) => s.start)).toEqual([
      '2026-07-19T07:00:00.000Z',
      '2026-07-21T07:00:00.000Z',
    ]);
  });
});
