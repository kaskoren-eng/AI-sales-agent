import { describe, expect, it } from 'vitest';
import {
  CALLBACK_SETTINGS_DEFAULTS,
  MAX_ATTEMPTS_CEILING,
  resolveCallbackSettings,
} from './callback-settings.js';
import { CALLBACK_DEFAULTS } from './callback-time.js';

/**
 * The rule this file encodes, borrowed wholesale from `reminder-settings.ts`: every knob is
 * per-tenant EXCEPT the ones that are safety boundaries, and a malformed setting must fail towards
 * the safe value rather than towards no value at all.
 */

describe('resolveCallbackSettings — absent or unusable settings', () => {
  it('no settings at all → the defaults, and the defaults are ON', () => {
    expect(resolveCallbackSettings(undefined)).toEqual(CALLBACK_SETTINGS_DEFAULTS);
    expect(resolveCallbackSettings(null)).toEqual(CALLBACK_SETTINGS_DEFAULTS);
    expect(resolveCallbackSettings({})).toEqual(CALLBACK_SETTINGS_DEFAULTS);
    expect(CALLBACK_SETTINGS_DEFAULTS.enabled).toBe(true);
  });

  it('the defaults ARE `CALLBACK_DEFAULTS` — one source of truth, not a second copy', () => {
    expect(CALLBACK_SETTINGS_DEFAULTS.proactiveWeekday).toEqual(CALLBACK_DEFAULTS.proactiveWeekday);
    expect(CALLBACK_SETTINGS_DEFAULTS.proactiveFriday).toEqual(CALLBACK_DEFAULTS.proactiveFriday);
    expect(CALLBACK_SETTINGS_DEFAULTS.maxAttempts).toBe(CALLBACK_DEFAULTS.maxAttempts);
  });

  it('a non-object under the key is ignored rather than half-read', () => {
    expect(resolveCallbackSettings({ callbacks: 'yes please' })).toEqual(CALLBACK_SETTINGS_DEFAULTS);
  });
});

describe('resolveCallbackSettings — enabled', () => {
  it('only an explicit false turns it off', () => {
    expect(resolveCallbackSettings({ callbacks: { enabled: false } }).enabled).toBe(false);
    expect(resolveCallbackSettings({ callbacks: { enabled: true } }).enabled).toBe(true);
    // Absent, null, a typo — all of them mean "the default", which is on.
    expect(resolveCallbackSettings({ callbacks: { enabled: null } }).enabled).toBe(true);
    expect(resolveCallbackSettings({ callbacks: {} }).enabled).toBe(true);
  });
});

describe('resolveCallbackSettings — maxAttempts is a ceiling, not a setting', () => {
  it('a tenant may SHORTEN the ladder', () => {
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 1 } }).maxAttempts).toBe(1);
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 2 } }).maxAttempts).toBe(2);
  });

  // The ceiling moved 3 → 5 on 2026-09-04, when the ladder became the tenant's to define. It did
  // not become a preference: a tenant may now choose 4 or 5 follow-ups, and still cannot choose
  // "keep dialling until he answers".
  it('a tenant may lengthen it up to the ceiling', () => {
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 4 } }).maxAttempts).toBe(4);
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 5 } }).maxAttempts).toBe(5);
  });

  it('a tenant may NOT go past the ceiling — stopping is the feature', () => {
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 9 } }).maxAttempts).toBe(MAX_ATTEMPTS_CEILING);
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 999 } }).maxAttempts).toBe(5);
  });

  it('zero or nonsense falls back rather than disabling the feature by the back door', () => {
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 0 } }).maxAttempts).toBe(1);
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: -4 } }).maxAttempts).toBe(1);
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 'three' } }).maxAttempts).toBe(3);
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: Number.NaN } }).maxAttempts).toBe(3);
  });
});

describe('resolveCallbackSettings — the proactive window', () => {
  it('accepts a well-formed narrowing', () => {
    const s = resolveCallbackSettings({
      callbacks: { proactiveWeekday: { start: '10:00', end: '17:00' } },
    });
    expect(s.proactiveWeekday).toEqual({ start: '10:00', end: '17:00' });
    // The other window is untouched.
    expect(s.proactiveFriday).toEqual(CALLBACK_SETTINGS_DEFAULTS.proactiveFriday);
  });

  it('a malformed or half-written window falls back to the DEFAULT window, never to "no window"', () => {
    const cases: unknown[] = [
      { start: '25:00', end: '17:00' },
      { start: '10:00' },
      { end: '17:00' },
      { start: '10-00', end: '17-00' },
      'all day',
      null,
    ];
    for (const proactiveWeekday of cases) {
      expect(resolveCallbackSettings({ callbacks: { proactiveWeekday } }).proactiveWeekday).toEqual(
        CALLBACK_SETTINGS_DEFAULTS.proactiveWeekday,
      );
    }
  });

  it('a degenerate window (end at or before start) falls back — an empty window would defer forever', () => {
    expect(
      resolveCallbackSettings({ callbacks: { proactiveWeekday: { start: '18:00', end: '09:00' } } })
        .proactiveWeekday,
    ).toEqual(CALLBACK_SETTINGS_DEFAULTS.proactiveWeekday);
    expect(
      resolveCallbackSettings({ callbacks: { proactiveWeekday: { start: '09:00', end: '09:00' } } })
        .proactiveWeekday,
    ).toEqual(CALLBACK_SETTINGS_DEFAULTS.proactiveWeekday);
  });

  it('THE HARD FLOOR IS UNREACHABLE FROM HERE — there is no field for it, at any spelling', () => {
    const s = resolveCallbackSettings({
      callbacks: {
        hardFloor: { earliest: '03:00', latest: '23:59' },
        proactiveWeekday: { start: '03:00', end: '23:00' },
      },
    }) as unknown as Record<string, unknown>;
    expect(s.hardFloor).toBeUndefined();
    // The tenant CAN ask to call from 03:00; `clampToWindow` still refuses, because the floor is
    // applied there and is read from CALLBACK_DEFAULTS, which no settings blob reaches.
    expect(s.proactiveWeekday).toEqual({ start: '03:00', end: '23:00' });
  });
});

describe('resolveCallbackSettings — disconnectedDelayMinutes', () => {
  it('is overridable within sane bounds', () => {
    expect(resolveCallbackSettings({ callbacks: { disconnectedDelayMinutes: 45 } }).disconnectedDelayMinutes).toBe(45);
    expect(resolveCallbackSettings({ callbacks: { disconnectedDelayMinutes: 0 } }).disconnectedDelayMinutes).toBe(1);
    expect(resolveCallbackSettings({ callbacks: { disconnectedDelayMinutes: 99_999 } }).disconnectedDelayMinutes).toBe(1440);
  });
});

describe('resolveCallbackSettings — the tenant defines its own follow-ups (Koren, 2026-09-04)', () => {
  const L = (raw: unknown) => resolveCallbackSettings({ callbacks: { ladders: raw } }).ladders;

  it('the shipped default is the ladder Koren specified: 3h → 1 business day → 3 business days', () => {
    const d = CALLBACK_SETTINGS_DEFAULTS.ladders.not_reached;
    expect(d.map((r) => r.offset)).toEqual([
      { unit: 'hours', value: 3 },
      { unit: 'business_days', value: 1 },
      { unit: 'business_days', value: 3 },
    ]);
    // …and the two later rungs move to the other half of the day rather than repeating the hour.
    expect(d.map((r) => r.timeOfDay)).toEqual(['keep', 'rotate', 'rotate']);
  });

  it('a tenant ladder replaces the default for that kind only', () => {
    const out = L({ not_reached: [{ after: { hours: 1 } }, { after: { businessDays: 2 } }] });
    expect(out.not_reached.map((r) => r.offset)).toEqual([
      { unit: 'hours', value: 1 },
      { unit: 'business_days', value: 2 },
    ]);
    expect(out.soft_defer).toEqual(CALLBACK_SETTINGS_DEFAULTS.ladders.soft_defer);
  });

  it('an EMPTY ladder is valid and means "do not chase this kind at all"', () => {
    expect(L({ not_reached: [] }).not_reached).toEqual([]);
  });

  it('rung 1 of an explicit callback stays the LEAD\'s own time, whatever the tenant writes', () => {
    // He named 22:00. A tenant cannot overwrite the one rung that belongs to him, and cannot
    // promote its own rungs into the wide honored window by writing them into this ladder.
    const out = L({ explicit: [{ after: { minutes: 30 } }] });
    expect(out.explicit[0]!.offset).toEqual({ unit: 'lead_time' });
    expect(out.explicit[0]!.window).toBe('honored');
    expect(out.explicit[1]!.offset).toEqual({ unit: 'minutes', value: 30 });
    expect(out.explicit[1]!.window).toBe('proactive');
  });

  it('every tenant-authored rung is proactive — `honored` is not reachable from settings', () => {
    const out = L({ soft_defer: [{ after: { hours: 2 }, window: 'honored' }] });
    expect(out.soft_defer.every((r) => r.window === 'proactive')).toBe(true);
  });

  it('a tenant cannot set a rung channel while the worker still dials unconditionally', () => {
    const out = L({ soft_defer: [{ after: { hours: 2 }, channel: 'whatsapp' }] });
    expect(out.soft_defer[0]!.channel).toBe('call');
  });

  it('a ladder past the ceiling is refused whole, not truncated into a surprise', () => {
    const six = Array.from({ length: 6 }, () => ({ after: { businessDays: 1 } }));
    expect(L({ not_reached: six }).not_reached).toEqual(CALLBACK_SETTINGS_DEFAULTS.ladders.not_reached);
  });

  it('ONE malformed rung discards the whole tenant ladder rather than silently shortening it', () => {
    const cases: unknown[] = [
      [{ after: { hours: 1 } }, { after: {} }],
      [{ after: { hours: 1, businessDays: 2 } }],          // two units at once
      [{ after: { hours: -3 } }],
      [{ after: { hours: 24 * 40 } }],                      // past the 30-day cap
      [{ after: { hours: 1 }, timeOfDay: 'evening' }],      // not a day part we know
      [{ after: { hours: 1 } }, 'nonsense'],
      'not an array',
    ];
    for (const c of cases) {
      expect(L({ not_reached: c }).not_reached).toEqual(CALLBACK_SETTINGS_DEFAULTS.ladders.not_reached);
    }
  });

  it('day-part anchors are a knob, and a malformed triple falls back whole', () => {
    expect(
      resolveCallbackSettings({ callbacks: { dayParts: { morning: '08:00', afternoon: '18:00', split: '12:00' } } })
        .dayParts,
    ).toEqual({ morning: '08:00', afternoon: '18:00', split: '12:00' });

    // morning must come before the split, which must come before the afternoon: a "rotation"
    // whose halves are the same hour, or inverted, is not a rotation.
    for (const bad of [
      { morning: '18:00', afternoon: '08:00', split: '13:00' },
      { morning: '10:00', afternoon: '16:00' },
      { morning: '10:00', afternoon: '16:00', split: '25:99' },
    ]) {
      expect(resolveCallbackSettings({ callbacks: { dayParts: bad } }).dayParts).toEqual(
        CALLBACK_SETTINGS_DEFAULTS.dayParts,
      );
    }
  });

  it('no settings at all still yields every kind, so the worker never checks for an override', () => {
    const out = resolveCallbackSettings({}).ladders;
    expect(Object.keys(out).sort()).toEqual(['disconnected', 'explicit', 'not_reached', 'soft_defer']);
  });
});
