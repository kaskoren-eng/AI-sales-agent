import { describe, expect, it } from 'vitest';
import { HANDOFF_DEFAULTS, resolveHandoffSettings } from './handoff-settings.js';

/**
 * The resolver runs mid-call on whatever JSON a tenant's settings blob happens to hold. Its only
 * hard contract: NEVER throw and never return a shape a caller has to re-check — a handoff must
 * not die because someone typed the config wrong.
 */
describe('resolveHandoffSettings', () => {
  it('missing / malformed / wrong-typed settings all fall back to defaults', () => {
    for (const input of [undefined, null, 42, 'handoff', {}, { handoff: null }, { handoff: 'koren' }, { handoff: [] }]) {
      expect(resolveHandoffSettings(input)).toEqual(HANDOFF_DEFAULTS);
    }
  });

  it('reads a fully configured owner', () => {
    const cfg = resolveHandoffSettings({
      handoff: {
        ownerName: 'קורן',
        ownerPhone: '+972501112222',
        ownerEmail: 'koren@clickscales.com',
        notify: ['whatsapp'],
      },
    });
    expect(cfg).toEqual({
      ownerName: 'קורן',
      ownerPhone: '+972501112222',
      ownerEmail: 'koren@clickscales.com',
      notify: ['whatsapp'],
    });
  });

  it('trims strings and treats blank/oversized/non-string values as unconfigured', () => {
    const cfg = resolveHandoffSettings({
      handoff: { ownerName: '  קורן  ', ownerPhone: '   ', ownerEmail: 12345, notify: [] },
    });
    expect(cfg.ownerName).toBe('קורן');
    expect(cfg.ownerPhone).toBeNull();
    expect(cfg.ownerEmail).toBeNull();
    // An empty notify list is a config mistake, not "notify nobody" — the owner still gets pinged.
    expect(cfg.notify).toEqual(HANDOFF_DEFAULTS.notify);
  });

  it('filters unknown channels out of notify instead of trusting the blob', () => {
    const cfg = resolveHandoffSettings({ handoff: { notify: ['whatsapp', 'sms', 'carrier_pigeon', 'email'] } });
    expect(cfg.notify).toEqual(['whatsapp', 'email']);
  });
});
