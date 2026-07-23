import { describe, expect, it } from 'vitest';
import { REMINDER_DEFAULTS, resolveReminderSettings } from './reminder-settings.js';

describe('resolveReminderSettings', () => {
  it('absent/garbage settings → full defaults (T-24h + T-1h, both channels, 21:00-08:00)', () => {
    expect(resolveReminderSettings(null)).toEqual(REMINDER_DEFAULTS);
    expect(resolveReminderSettings({ reminders: 'nope' })).toEqual(REMINDER_DEFAULTS);
  });

  it('enabled:false is honored — reminders are a feature, not a safety boundary', () => {
    expect(resolveReminderSettings({ reminders: { enabled: false } }).enabled).toBe(false);
  });

  it('offsets are clamped (5min–14d), deduped, capped at 6, rounded', () => {
    const r = resolveReminderSettings({
      reminders: { offsetsMinutes: [1, 60, 60.4, 2880, 999999, -5, 'x', 10, 20, 30, 40, 50] },
    });
    expect(r.offsetsMinutes).not.toContain(1); // < 5 min
    expect(r.offsetsMinutes).not.toContain(999999); // > 14 days
    expect(r.offsetsMinutes.filter((v) => v === 60)).toHaveLength(1); // deduped after rounding
    expect(r.offsetsMinutes.length).toBeLessThanOrEqual(6);
  });

  it('all-invalid offsets fall back to the defaults — never an empty schedule silently', () => {
    expect(resolveReminderSettings({ reminders: { offsetsMinutes: [1, -3] } }).offsetsMinutes).toEqual([1440, 60]);
  });

  it('QUIET HOURS CANNOT BE REMOVED: absent, malformed, or degenerate → the default window', () => {
    for (const qh of [undefined, 'off', { start: '25:99', end: '08:00' }, { start: '10:00', end: '10:00' }]) {
      const r = resolveReminderSettings({ reminders: { quietHours: qh } });
      expect(r.quietHours).toEqual({ start: '21:00', end: '08:00' });
    }
  });

  it('a valid custom quiet window is honored (per-tenant knob)', () => {
    const r = resolveReminderSettings({ reminders: { quietHours: { start: '22:00', end: '07:30' } } });
    expect(r.quietHours).toEqual({ start: '22:00', end: '07:30' });
  });

  it('channels filter to the two known values', () => {
    const r = resolveReminderSettings({ reminders: { channels: ['whatsapp', 'pigeon'] } });
    expect(r.channels).toEqual(['whatsapp']);
  });
});
