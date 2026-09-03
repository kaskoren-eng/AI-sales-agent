import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DEFAULTS,
  CALLBACK_LADDERS,
  CALLBACK_LADDER_EXPLICIT,
  CALLBACK_LADDER_SOFT_DEFER,
  addIsraelBusinessDays,
  clampToWindow,
  dialOrdinal,
  israelInstantAt,
  nextRung,
  planCallbackTime,
  resolveCallbackDueAt,
} from './callback-time.js';

/**
 * Every instant here is pinned in BOTH Israeli clock regimes, the way `israel-time.test.ts` does:
 *
 *   Jan 2026 = IST, UTC+2   →  2026-01-13T09:00:00Z is Tuesday 11:00 in Tel Aviv
 *   Jul 2026 = IDT, UTC+3   →  2026-07-21T08:00:00Z is Tuesday 11:00 in Tel Aviv
 *
 * and across the 2026 spring-forward, which happens on FRIDAY 2026-03-27 at 02:00 → 03:00. The
 * last IST instant is 2026-03-26T23:59:59Z; from 2026-03-27T00:00:00Z Israel is UTC+3. That single
 * boundary is why this module exists: a phone ringing an hour early is invisible to every other
 * test in the repo.
 *
 * A failure here with garbled offsets means a slim-ICU Node build — the agent cannot run on it
 * either, so the failure is the point.
 */

const jan = (iso: string): Date => new Date(iso); // readability only

describe('resolveCallbackDueAt — in_minutes', () => {
  it('adds the minutes, verbatim ("תתקשר אליי עוד שעה" → +60)', () => {
    const now = new Date('2026-01-13T09:00:00.000Z'); // Tue 11:00 IST
    const r = resolveCallbackDueAt({ when_kind: 'in_minutes', in_minutes: 60 }, now);
    expect(r.dueAt.toISOString()).toBe('2026-01-13T10:00:00.000Z');
    expect(r.basis).toBe('in_minutes');
    expect(r.fallbacks).toEqual([]);
  });

  it('holds in IDT — the offset must not leak into a pure duration', () => {
    const now = new Date('2026-07-21T08:00:00.000Z'); // Tue 11:00 IDT
    const r = resolveCallbackDueAt({ when_kind: 'in_minutes', in_minutes: 10 }, now);
    expect(r.dueAt.toISOString()).toBe('2026-07-21T08:10:00.000Z');
  });

  it('clamps below the floor rather than dialling in two minutes', () => {
    const now = new Date('2026-01-13T09:00:00.000Z');
    const r = resolveCallbackDueAt({ when_kind: 'in_minutes', in_minutes: 1 }, now);
    expect(r.dueAt.toISOString()).toBe('2026-01-13T09:05:00.000Z');
    expect(r.fallbacks).toContain('minutes_clamped');
  });

  it('falls back to the soft-defer rung when the model sends null minutes', () => {
    // gpt-5.4 fills unknown tool fields with an explicit null; the resolver must survive it.
    const now = new Date('2026-01-13T09:00:00.000Z');
    const r = resolveCallbackDueAt({ when_kind: 'in_minutes', in_minutes: null }, now);
    expect(r.dueAt.toISOString()).toBe('2026-01-13T12:00:00.000Z'); // +3h, ladder rung 1
    expect(r.basis).toBe('ladder_default');
    expect(r.fallbacks).toEqual(['missing_minutes']);
  });
});

describe('resolveCallbackDueAt — at_time', () => {
  it('resolves a bare clock time to the next Israeli 16:00 (IST, UTC+2)', () => {
    const now = jan('2026-01-13T09:00:00.000Z'); // Tue 11:00 IST
    const r = resolveCallbackDueAt({ when_kind: 'at_time', time_hhmm: '16:00' }, now);
    expect(r.dueAt.toISOString()).toBe('2026-01-13T14:00:00.000Z'); // 16:00 IST
    expect(r.basis).toBe('clock_time');
  });

  it('resolves the same clock time an hour earlier in UTC in summer (IDT, UTC+3)', () => {
    const now = new Date('2026-07-21T08:00:00.000Z'); // Tue 11:00 IDT
    const r = resolveCallbackDueAt({ when_kind: 'at_time', time_hhmm: '16:00' }, now);
    expect(r.dueAt.toISOString()).toBe('2026-07-21T13:00:00.000Z'); // 16:00 IDT
  });

  it('rolls a bare clock time already past today to tomorrow', () => {
    const now = new Date('2026-01-13T15:00:00.000Z'); // Tue 17:00 IST
    const r = resolveCallbackDueAt({ when_kind: 'at_time', time_hhmm: '16:00' }, now);
    expect(r.dueAt.toISOString()).toBe('2026-01-14T14:00:00.000Z'); // Wed 16:00 IST
  });

  it('resolves "מחר בארבע" — day + time, in winter', () => {
    const now = jan('2026-01-13T09:00:00.000Z');
    const r = resolveCallbackDueAt(
      { when_kind: 'at_time', day: 'tomorrow', time_hhmm: '16:00' },
      now,
    );
    expect(r.dueAt.toISOString()).toBe('2026-01-14T14:00:00.000Z');
    expect(r.basis).toBe('day_and_time');
  });

  it('DST BOUNDARY — "מחר בעשר" said on the Thursday night before the spring-forward', () => {
    // now  = Thu 2026-03-26 22:00 IST (UTC+2). Israel moves to IDT at 02:00 on Friday the 27th.
    // The naive answer (now + 12h in UTC) is 10:00 IST = 08:00Z and rings an hour EARLY.
    const now = new Date('2026-03-26T20:00:00.000Z');
    const r = resolveCallbackDueAt(
      { when_kind: 'at_time', day: 'tomorrow', time_hhmm: '10:00' },
      now,
    );
    expect(r.dueAt.toISOString()).toBe('2026-03-27T07:00:00.000Z'); // 10:00 IDT, UTC+3
  });

  it('DST BOUNDARY — the same request expressed as a bare clock time agrees', () => {
    const now = new Date('2026-03-26T20:00:00.000Z');
    const r = resolveCallbackDueAt({ when_kind: 'at_time', time_hhmm: '10:00' }, now);
    expect(r.dueAt.toISOString()).toBe('2026-03-27T07:00:00.000Z');
  });

  it('resolves a named weekday to its next occurrence', () => {
    const now = jan('2026-01-13T09:00:00.000Z'); // Tuesday
    const r = resolveCallbackDueAt(
      { when_kind: 'at_time', day: 'sunday', time_hhmm: '10:00' },
      now,
    );
    expect(r.dueAt.toISOString()).toBe('2026-01-18T08:00:00.000Z'); // Sun 2026-01-18 10:00 IST
  });

  it('rolls a named weekday a full week when today is that weekday and the hour has passed', () => {
    const now = new Date('2026-01-13T15:00:00.000Z'); // Tue 17:00 IST
    const r = resolveCallbackDueAt(
      { when_kind: 'at_time', day: 'tuesday', time_hhmm: '11:00' },
      now,
    );
    expect(r.dueAt.toISOString()).toBe('2026-01-20T09:00:00.000Z'); // next Tue 11:00 IST
    expect(r.fallbacks).toContain('day_already_past');
  });

  it('rolls "today" to tomorrow when the hour is already gone', () => {
    const now = new Date('2026-01-13T15:00:00.000Z'); // Tue 17:00 IST
    const r = resolveCallbackDueAt(
      { when_kind: 'at_time', day: 'today', time_hhmm: '11:00' },
      now,
    );
    expect(r.dueAt.toISOString()).toBe('2026-01-14T09:00:00.000Z');
    expect(r.fallbacks).toContain('day_already_past');
  });

  it('uses the default hour when a day is named without one', () => {
    const now = jan('2026-01-13T09:00:00.000Z');
    const r = resolveCallbackDueAt({ when_kind: 'at_time', day: 'tomorrow', time_hhmm: null }, now);
    expect(r.dueAt.toISOString()).toBe('2026-01-14T08:00:00.000Z'); // 10:00 IST
    expect(r.fallbacks).toEqual(['missing_time']);
  });

  it('falls back to the ladder when NEITHER day nor time survived', () => {
    const now = jan('2026-01-13T09:00:00.000Z');
    const r = resolveCallbackDueAt({ when_kind: 'at_time', time_hhmm: 'later' as string }, now);
    expect(r.basis).toBe('ladder_default');
    expect(r.fallbacks).toEqual(['malformed_time', 'missing_time']);
    expect(r.dueAt.toISOString()).toBe('2026-01-13T12:00:00.000Z');
  });
});

describe('resolveCallbackDueAt — unspecified', () => {
  it('is rung 1 of the soft-defer ladder: +3 hours', () => {
    const now = new Date('2026-07-21T08:00:00.000Z');
    const r = resolveCallbackDueAt({ when_kind: 'unspecified' }, now);
    expect(r.dueAt.toISOString()).toBe('2026-07-21T11:00:00.000Z');
    expect(r.basis).toBe('ladder_default');
  });
});

describe('israelInstantAt — the DST arithmetic everything else rests on', () => {
  /**
   * These exist because a mutation test caught a hole: disabling the two-pass offset correction
   * left every window test green. The reason is that `startOfIsraelDay` is itself an hour out on
   * both 2026 transition days, and that error cancels against the 23-/25-hour day for any target
   * AFTER the transition — which every window hour in this module is. So the correction is only
   * observable below 02:00, and without these cases it would be a safety net nobody had seen work.
   */
  it('is exact on an ordinary winter day', () => {
    const base = new Date('2026-01-13T10:00:00.000Z');
    expect(israelInstantAt(base, 0, 9 * 60).toISOString()).toBe('2026-01-13T07:00:00.000Z');
  });

  it('is exact on an ordinary summer day', () => {
    const base = new Date('2026-07-21T10:00:00.000Z');
    expect(israelInstantAt(base, 0, 9 * 60).toISOString()).toBe('2026-07-21T06:00:00.000Z');
  });

  it('SPRING FORWARD: 01:00 on 2026-03-27 is BEFORE the 02:00 jump — still IST, UTC+2', () => {
    // Without the correction pass this returns 22:00Z, which is 00:00 in Israel: an hour early.
    const base = new Date('2026-03-27T10:00:00.000Z');
    expect(israelInstantAt(base, 0, 60).toISOString()).toBe('2026-03-26T23:00:00.000Z');
  });

  it('SPRING FORWARD: 09:00 the same day is AFTER the jump — IDT, UTC+3', () => {
    const base = new Date('2026-03-27T10:00:00.000Z');
    expect(israelInstantAt(base, 0, 9 * 60).toISOString()).toBe('2026-03-27T06:00:00.000Z');
  });

  it('FALL BACK: 09:00 on 2026-10-25 is after the 02:00 rewind — IST, UTC+2', () => {
    const base = new Date('2026-10-25T10:00:00.000Z');
    expect(israelInstantAt(base, 0, 9 * 60).toISOString()).toBe('2026-10-25T07:00:00.000Z');
  });

  it('crosses the spring-forward boundary by day offset, not by adding 24 hours', () => {
    // Thursday the 26th + 1 day must be Friday the 27th at 09:00 IDT (06:00Z), not 07:00Z.
    const base = new Date('2026-03-26T20:00:00.000Z');
    expect(israelInstantAt(base, 1, 9 * 60).toISOString()).toBe('2026-03-27T06:00:00.000Z');
  });
});

describe('clampToWindow — 22:00, honored vs proactive', () => {
  // Koren, 2026-09-01: "אם הוא מבקש שיחה בשעה 22:00 אז יקבל". This pair IS that decision.
  const now = new Date('2026-01-13T09:00:00.000Z'); // Tue 11:00 IST
  const tenPm = new Date('2026-01-13T20:00:00.000Z'); // Tue 22:00 IST

  it('HONORS 22:00 on attempt 1 of a time the lead named — untouched', () => {
    const c = clampToWindow(tenPm, { requestedByLead: true, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-01-13T20:00:00.000Z');
    expect(c.window).toBe('honored');
    expect(c.moved).toBe(false);
    expect(c.reasons).toEqual([]);
  });

  it('does NOT honor 22:00 on the retry — he asked for 22:00 once, not three nights running', () => {
    const c = clampToWindow(tenPm, { requestedByLead: true, attempt: 2 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-01-14T07:00:00.000Z'); // Wed 09:00 IST
    expect(c.window).toBe('proactive');
    expect(c.moved).toBe(true);
    expect(c.reasons).toEqual(['proactive_window']);
  });

  it('does NOT honor 22:00 that nobody asked for (a soft defer that landed there)', () => {
    const c = clampToWindow(tenPm, { requestedByLead: false, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-01-14T07:00:00.000Z');
    expect(c.window).toBe('proactive');
  });

  it('attempt 0 — a row inserted but not yet dialled — still counts as rung 1', () => {
    const c = clampToWindow(tenPm, { requestedByLead: true, attempt: 0 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-01-13T20:00:00.000Z');
  });
});

describe('clampToWindow — the hard floor nothing overrides', () => {
  it('refuses 23:30 even when the lead asked for it — pushed to 07:00', () => {
    const now = new Date('2026-01-13T09:00:00.000Z'); // Tue 11:00 IST
    const half11 = new Date('2026-01-13T21:30:00.000Z'); // Tue 23:30 IST
    const c = clampToWindow(half11, { requestedByLead: true, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-01-14T05:00:00.000Z'); // Wed 07:00 IST
    expect(c.window).toBe('honored');
    expect(c.reasons).toEqual(['night_floor']);
  });

  it('refuses 04:00 even when the lead asked for it — pushed forward to 07:00 the same day', () => {
    const now = new Date('2026-01-13T01:00:00.000Z'); // Tue 03:00 IST
    const four = new Date('2026-01-13T02:00:00.000Z'); // Tue 04:00 IST
    const c = clampToWindow(four, { requestedByLead: true, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-01-13T05:00:00.000Z'); // Tue 07:00 IST
    expect(c.reasons).toEqual(['night_floor']);
  });

  it('SATURDAY is never dialled, honored window or not', () => {
    const now = new Date('2026-01-16T09:00:00.000Z'); // Fri 2026-01-16 11:00 IST
    const sat = new Date('2026-01-17T10:00:00.000Z'); // Sat 2026-01-17 12:00 IST
    const honored = clampToWindow(sat, { requestedByLead: true, attempt: 1 }, now);
    expect(honored.dueAt.toISOString()).toBe('2026-01-18T05:00:00.000Z'); // Sun 07:00 IST
    expect(honored.reasons).toEqual(['shabbat']);

    const proactive = clampToWindow(sat, { requestedByLead: false, attempt: 1 }, now);
    expect(proactive.dueAt.toISOString()).toBe('2026-01-18T07:00:00.000Z'); // Sun 09:00 IST
    expect(proactive.reasons).toEqual(['shabbat']);
  });

  it('an ISRAELI HOLIDAY is never dialled — Yom Kippur 2026-09-20 rolls to the Monday', () => {
    // 2026-09-20 (Sunday) is in ISRAEL_HOLIDAYS. Reusing that list rather than copying it is the
    // whole point: one place to fix when the dates are extended past 2027.
    const now = new Date('2026-09-18T06:00:00.000Z'); // Fri 09:00 IDT
    const yomKippur = new Date('2026-09-20T08:00:00.000Z'); // Sun 11:00 IDT
    const c = clampToWindow(yomKippur, { requestedByLead: true, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-09-21T04:00:00.000Z'); // Mon 07:00 IDT
    expect(c.reasons).toEqual(['holiday']);
  });

  it('a request already in the past is pulled to now, not dialled backwards', () => {
    const now = new Date('2026-01-13T09:00:00.000Z'); // Tue 11:00 IST — inside both windows
    const past = new Date('2026-01-13T08:00:00.000Z');
    const c = clampToWindow(past, { requestedByLead: false, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-01-13T09:00:00.000Z');
    expect(c.moved).toBe(true);
    expect(c.reasons).toEqual(['in_past']);
  });
});

describe('clampToWindow — Friday', () => {
  it('FRIDAY EVENING: the proactive window closed at 13:00, so it rolls over Shabbat to Sunday', () => {
    const now = new Date('2026-07-17T06:00:00.000Z'); // Fri 2026-07-17 09:00 IDT
    const fridayEvening = new Date('2026-07-17T15:00:00.000Z'); // Fri 18:00 IDT
    const c = clampToWindow(fridayEvening, { requestedByLead: false, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-07-19T06:00:00.000Z'); // Sun 2026-07-19 09:00 IDT
    expect(c.window).toBe('proactive');
    expect(c.reasons).toEqual(['proactive_window', 'shabbat']);
  });

  it('FRIDAY EVENING is fine in the honored window — 18:00 is inside the hard floor', () => {
    const now = new Date('2026-07-17T06:00:00.000Z');
    const fridayEvening = new Date('2026-07-17T15:00:00.000Z');
    const c = clampToWindow(fridayEvening, { requestedByLead: true, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-07-17T15:00:00.000Z');
    expect(c.moved).toBe(false);
  });

  it('Friday 11:00 is inside the proactive window and is left alone', () => {
    const now = new Date('2026-07-17T05:00:00.000Z'); // Fri 08:00 IDT
    const eleven = new Date('2026-07-17T08:00:00.000Z'); // Fri 11:00 IDT
    const c = clampToWindow(eleven, { requestedByLead: false, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-07-17T08:00:00.000Z');
    expect(c.reasons).toEqual([]);
  });

  it('Friday 08:00 is before the window and moves forward to 09:00 the same morning', () => {
    const now = new Date('2026-07-17T04:00:00.000Z'); // Fri 07:00 IDT
    const eight = new Date('2026-07-17T05:00:00.000Z'); // Fri 08:00 IDT
    const c = clampToWindow(eight, { requestedByLead: false, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-07-17T06:00:00.000Z'); // Fri 09:00 IDT
    expect(c.reasons).toEqual(['proactive_window']);
  });
});

describe('clampToWindow — across the DST boundary', () => {
  it('a Thursday-night deferral lands on Friday 09:00 IDT, not 09:00 IST', () => {
    // now = Thu 2026-03-26 22:00 IST. Proactive closed at 20:00, so it rolls to Friday — which is
    // the first IDT day of the year. 09:00 IDT is 06:00Z; 09:00 IST would be 07:00Z.
    const now = new Date('2026-03-26T20:00:00.000Z');
    const c = clampToWindow(now, { requestedByLead: false, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-03-27T06:00:00.000Z');
    expect(c.window).toBe('proactive');
    expect(c.reasons).toEqual(['proactive_window']);
  });

  it('the same Thursday 22:00 is honored untouched when the lead named it', () => {
    const now = new Date('2026-03-26T20:00:00.000Z');
    const c = clampToWindow(now, { requestedByLead: true, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-03-26T20:00:00.000Z');
    expect(c.moved).toBe(false);
  });

  it('and across the autumn fall-back: Sunday 2026-10-25 is already IST again', () => {
    // Israel returns to UTC+2 at 02:00 on 2026-10-25. A Saturday-night request rolls to Sunday
    // 09:00 IST = 07:00Z (it would be 06:00Z if the module still thought it was summer).
    const now = new Date('2026-10-24T17:00:00.000Z'); // Sat 20:00 IDT
    const c = clampToWindow(now, { requestedByLead: false, attempt: 1 }, now);
    expect(c.dueAt.toISOString()).toBe('2026-10-25T07:00:00.000Z');
    expect(c.reasons).toEqual(['shabbat']);
  });
});

describe('planCallbackTime — both halves, which is how callers will use it', () => {
  it('"תתקשר אליי בעשר בלילה" from a Tuesday morning: honored, and unmoved', () => {
    const now = jan('2026-01-13T09:00:00.000Z');
    const p = planCallbackTime(
      { when_kind: 'at_time', time_hhmm: '22:00' },
      { requestedByLead: true, attempt: 1 },
      now,
    );
    expect(p.dueAt.toISOString()).toBe('2026-01-13T20:00:00.000Z');
    expect(p.basis).toBe('clock_time');
    expect(p.moved).toBe(false);
  });

  it('"לא עכשיו" at 19:00 on a Thursday: +3h lands at 22:00, proactive drags it to Sunday', () => {
    // Thu 2026-01-15 19:00 IST. +3h = 22:00, outside 09:00–20:00 → Friday, whose window is
    // 09:00–13:00 and starts at 09:00 IST = 07:00Z.
    const now = new Date('2026-01-15T17:00:00.000Z');
    const p = planCallbackTime(
      { when_kind: 'unspecified' },
      { requestedByLead: false, attempt: 1 },
      now,
    );
    expect(p.basis).toBe('ladder_default');
    expect(p.dueAt.toISOString()).toBe('2026-01-16T07:00:00.000Z'); // Fri 09:00 IST
    expect(p.reasons).toEqual(['proactive_window']);
  });
});

describe('the ladder is data, and it says what §7 says', () => {
  it('explicit: his time, then +45 min, then +1 business day — honored only on rung 1', () => {
    expect(CALLBACK_LADDER_EXPLICIT.map((r) => r.offset)).toEqual([
      { unit: 'lead_time' },
      { unit: 'minutes', value: 45 },
      { unit: 'business_days', value: 1 },
    ]);
    expect(CALLBACK_LADDER_EXPLICIT.map((r) => r.window)).toEqual([
      'honored',
      'proactive',
      'proactive',
    ]);
  });

  it('soft defer: +3h, +1 business day, +3 business days — never honored', () => {
    expect(CALLBACK_LADDER_SOFT_DEFER.map((r) => r.offset)).toEqual([
      { unit: 'hours', value: 3 },
      { unit: 'business_days', value: 1 },
      { unit: 'business_days', value: 3 },
    ]);
    expect(CALLBACK_LADDER_SOFT_DEFER.every((r) => r.window === 'proactive')).toBe(true);
  });

  it('not_reached and disconnected enter the soft-defer ladder at rung 1', () => {
    expect(CALLBACK_LADDERS.not_reached).toBe(CALLBACK_LADDER_SOFT_DEFER);
    expect(CALLBACK_LADDERS.disconnected).toBe(CALLBACK_LADDER_SOFT_DEFER);
  });

  it('stops after three dials, and the last word is one message', () => {
    expect(CALLBACK_DEFAULTS.maxAttempts).toBe(3);
    expect(CALLBACK_LADDER_EXPLICIT).toHaveLength(3);
    expect(CALLBACK_LADDER_SOFT_DEFER).toHaveLength(3);
    expect(CALLBACK_DEFAULTS.finalMessageChannel).toBe('whatsapp');
  });

  it('the proactive window is the narrowed one — NOT operating_hours 09:00–23:00', () => {
    expect(CALLBACK_DEFAULTS.proactiveWeekday).toEqual({ start: '09:00', end: '20:00' });
    expect(CALLBACK_DEFAULTS.proactiveFriday).toEqual({ start: '09:00', end: '13:00' });
    expect(CALLBACK_DEFAULTS.hardFloor).toEqual({ earliest: '07:00', latest: '23:00' });
  });
});

// -----------------------------------------------------------------------------
// Climbing the ladder - added with the callback worker (F1.3)
// -----------------------------------------------------------------------------

describe('dialOrdinal', () => {
  it('a fresh row (0 dials) is asking about dial 1; after one dial it is asking about dial 2', () => {
    expect(dialOrdinal(0)).toBe(1);
    expect(dialOrdinal(1)).toBe(2);
    expect(dialOrdinal(2)).toBe(3);
  });

  it('THE REGRESSION: rung 2 must fall OUT of the honored window, and only the ordinal does that', () => {
    // 2026-09-07T19:00:00Z is Monday 22:00 in Tel Aviv. `windowFor` treats attempt 0 and 1 alike
    // (both mean "rung 1"), so passing the raw `attempt` after one dial keeps 22:00 honored.
    const at2200 = new Date('2026-09-07T19:00:00.000Z');
    const ctx = { requestedByLead: true };
    const attemptsMade = 1;

    const wrong = clampToWindow(at2200, { ...ctx, attempt: attemptsMade }, at2200);
    const right = clampToWindow(at2200, { ...ctx, attempt: dialOrdinal(attemptsMade) }, at2200);

    expect(wrong.window).toBe('honored');
    expect(wrong.moved).toBe(false);
    expect(right.window).toBe('proactive');
    // Pushed to Tuesday 09:00 Israel.
    expect(right.dueAt.toISOString()).toBe('2026-09-08T06:00:00.000Z');
  });
});

describe('addIsraelBusinessDays', () => {
  const MON_NOON = new Date('2026-09-07T09:00:00.000Z'); // Monday 12:00 Israel

  it('keeps the wall-clock hour', () => {
    expect(addIsraelBusinessDays(MON_NOON, 1).toISOString()).toBe('2026-09-08T09:00:00.000Z');
    expect(addIsraelBusinessDays(MON_NOON, 3).toISOString()).toBe('2026-09-10T09:00:00.000Z');
  });

  it('Saturday does not count', () => {
    const THU = new Date('2026-09-03T09:00:00.000Z'); // Thursday 12:00 Israel
    // Friday IS a working day in Israel, so +1 is Friday; +2 skips Saturday and lands on Sunday.
    expect(addIsraelBusinessDays(THU, 1).toISOString()).toBe('2026-09-04T09:00:00.000Z');
    expect(addIsraelBusinessDays(THU, 2).toISOString()).toBe('2026-09-06T09:00:00.000Z');
  });

  it('Israeli holidays do not count either - Rosh Hashana 2026 costs the same as a weekend', () => {
    // From Wednesday 2026-09-09: Thu 10 is one; Fri 11 and Sat 12 are Rosh Hashana; Sun 13 is two;
    // Mon 14 is three.
    const WED = new Date('2026-09-09T09:00:00.000Z');
    expect(addIsraelBusinessDays(WED, 3).toISOString()).toBe('2026-09-14T09:00:00.000Z');
  });

  it('zero and negative are identities, not a walk backwards through the calendar', () => {
    expect(addIsraelBusinessDays(MON_NOON, 0).toISOString()).toBe(MON_NOON.toISOString());
    expect(addIsraelBusinessDays(MON_NOON, -3).toISOString()).toBe(MON_NOON.toISOString());
  });

  it('survives the autumn DST transition with the hour intact - 2026-10-25, IDT to IST', () => {
    // Friday 2026-10-23 12:00 Israel is 09:00Z (IDT). Two business days later is Monday the 26th,
    // by which time Israel is UTC+2, so the same 12:00 is 10:00Z. Adding 48h would say 09:00Z and
    // ring an hour early.
    const FRI = new Date('2026-10-23T09:00:00.000Z');
    expect(addIsraelBusinessDays(FRI, 2).toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });
});

describe('nextRung', () => {
  const MON_NOON = new Date('2026-09-07T09:00:00.000Z');

  it('after one dial on an explicit callback, rung 2 is +45 minutes', () => {
    const plan = nextRung('explicit', 1, MON_NOON);
    expect(plan?.rung.rung).toBe(2);
    expect(plan?.dueAt.toISOString()).toBe('2026-09-07T09:45:00.000Z');
  });

  it('after two dials, rung 3 is the next business day at the same hour', () => {
    const plan = nextRung('explicit', 2, MON_NOON);
    expect(plan?.rung.rung).toBe(3);
    expect(plan?.dueAt.toISOString()).toBe('2026-09-08T09:00:00.000Z');
  });

  it('a soft defer climbs +1 then +3 business days', () => {
    expect(nextRung('soft_defer', 1, MON_NOON)?.dueAt.toISOString()).toBe('2026-09-08T09:00:00.000Z');
    expect(nextRung('soft_defer', 2, MON_NOON)?.dueAt.toISOString()).toBe('2026-09-10T09:00:00.000Z');
  });

  it('a disconnected callback uses the soft-defer ladder', () => {
    expect(nextRung('disconnected', 1, MON_NOON)?.dueAt.toISOString()).toBe(
      nextRung('soft_defer', 1, MON_NOON)?.dueAt.toISOString(),
    );
  });

  it('AND THEN IT STOPS - after the last rung there is no next one', () => {
    expect(nextRung('explicit', 3, MON_NOON)).toBeNull();
    expect(nextRung('soft_defer', 3, MON_NOON)).toBeNull();
    expect(nextRung('not_reached', 9, MON_NOON)).toBeNull();
  });

  it('rung 1 is never asked for through here - a dial has always been made by then', () => {
    // Defensive only: index 0 of the explicit ladder is `lead_time`, which has no arithmetic. If
    // it is ever reached it must not resolve to "now", because that is a redial, not a rung.
    const plan = nextRung('explicit', 0, MON_NOON);
    expect(plan?.dueAt.getTime()).toBeGreaterThan(MON_NOON.getTime());
  });
});

describe('clampToWindow - per-tenant proactive hours', () => {
  it('honours a tenant narrowing', () => {
    const at1830 = new Date('2026-09-07T15:30:00.000Z'); // Monday 18:30 Israel
    const cfg = {
      proactiveWeekday: { start: '10:00', end: '17:00' },
      proactiveFriday: { start: '09:00', end: '13:00' },
    };
    const out = clampToWindow(at1830, { requestedByLead: false, attempt: 1 }, at1830, cfg);
    expect(out.moved).toBe(true);
    // Pushed to 10:00 Tuesday Israel.
    expect(out.dueAt.toISOString()).toBe('2026-09-08T07:00:00.000Z');
  });

  it('the HARD FLOOR is not in the config and cannot be widened by it', () => {
    const at0400 = new Date('2026-09-07T01:00:00.000Z'); // Monday 04:00 Israel
    const cfg = {
      proactiveWeekday: { start: '00:00', end: '23:59' },
      proactiveFriday: { start: '00:00', end: '23:59' },
    };
    // A lead who asked for it gets the honored window, which is the hard floor 07:00-23:00 - the
    // tenant's 00:00 start is irrelevant, because `requestedByLead` selects the floor, not the cfg.
    const honored = clampToWindow(at0400, { requestedByLead: true, attempt: 1 }, at0400, cfg);
    expect(honored.dueAt.toISOString()).toBe('2026-09-07T04:00:00.000Z'); // 07:00 Israel
    expect(honored.reasons).toContain('night_floor');
  });

  it('Saturday is refused whatever the tenant configures', () => {
    const SAT = new Date('2026-09-05T09:00:00.000Z');
    const cfg = {
      proactiveWeekday: { start: '00:00', end: '23:59' },
      proactiveFriday: { start: '00:00', end: '23:59' },
    };
    const out = clampToWindow(SAT, { requestedByLead: true, attempt: 1 }, SAT, cfg);
    expect(out.reasons).toContain('shabbat');
    expect(out.dueAt.getTime()).toBeGreaterThan(SAT.getTime());
  });

  it('with no config it behaves exactly as it did - every existing caller is untouched', () => {
    const at2100 = new Date('2026-09-07T18:00:00.000Z'); // Monday 21:00 Israel
    const ctx = { requestedByLead: false, attempt: 1 };
    expect(clampToWindow(at2100, ctx, at2100).dueAt.toISOString()).toBe(
      clampToWindow(at2100, ctx, at2100, CALLBACK_DEFAULTS).dueAt.toISOString(),
    );
  });
});
