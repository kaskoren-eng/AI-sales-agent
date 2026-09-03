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

  it('a tenant may NOT lengthen it — stopping is the feature', () => {
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 9 } }).maxAttempts).toBe(MAX_ATTEMPTS_CEILING);
    expect(resolveCallbackSettings({ callbacks: { maxAttempts: 999 } }).maxAttempts).toBe(3);
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
