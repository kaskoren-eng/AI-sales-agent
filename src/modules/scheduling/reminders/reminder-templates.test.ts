import { describe, expect, it } from 'vitest';
import type { BusinessProfile } from '../../settings/settings.service.js';
import { buildReminderMessage } from './reminder-templates.js';

const BASE = {
  leadName: 'דנה',
  slotText: 'מחר, יום שלישי, 22 ביולי, בשעה 11:00',
  meetLink: 'https://meet.google.com/abc',
  profile: { companyName: 'ClickScales', toneOfVoice: 'חם וקליל' } as BusinessProfile,
};

describe('buildReminderMessage', () => {
  it('T-24h WhatsApp: name, slot, company, link, and the reply-to-reschedule hook', () => {
    const m = buildReminderMessage({ ...BASE, kind: 't24', channel: 'whatsapp' });
    expect(m.body).toContain('דנה');
    expect(m.body).toContain('22 ביולי');
    expect(m.body).toContain('עם ClickScales');
    expect(m.body).toContain('https://meet.google.com/abc');
    expect(m.body).toContain('תענה לי כאן');
    expect(m.subject).toBeUndefined();
  });

  it('T-1h email: subject says one hour, body keeps the hook', () => {
    const m = buildReminderMessage({ ...BASE, kind: 't1', channel: 'email' });
    expect(m.subject).toContain('בעוד שעה');
    expect(m.body).toContain('תענה לי כאן');
  });

  it('no meet link → the whole line disappears, never undefined/blank', () => {
    const m = buildReminderMessage({ ...BASE, meetLink: undefined, kind: 't24', channel: 'whatsapp' });
    expect(m.body).not.toContain('undefined');
    expect(m.body).not.toContain('הלינק');
    expect(m.body).not.toMatch(/\n\n/);
  });

  it('formal tone (BusinessProfile) switches the register — no emoji, אנא-style Hebrew', () => {
    const m = buildReminderMessage({
      ...BASE,
      profile: { companyName: 'משרד עו״ד לוי', toneOfVoice: 'רשמי' } as BusinessProfile,
      kind: 't24',
      channel: 'whatsapp',
    });
    expect(m.body).not.toContain('😊');
    expect(m.body).toContain('שלום דנה');
    expect(m.body).toContain('אנא השב');
  });

  it('tenant overrides beat both registers, with placeholder interpolation', () => {
    const m = buildReminderMessage({
      ...BASE,
      kind: 't24',
      channel: 'whatsapp',
      overrides: { t24_whatsapp: 'תזכורת מ-{company} ל-{lead_name}: {slot}. קישור: {meet_link}. תענה לי כאן לשינוי.' },
    });
    expect(m.body).toBe(
      'תזכורת מ-ClickScales ל-דנה: מחר, יום שלישי, 22 ביולי, בשעה 11:00. קישור: https://meet.google.com/abc. תענה לי כאן לשינוי.',
    );
  });

  it('no BusinessProfile at all → graceful phrasing without a company', () => {
    const m = buildReminderMessage({ ...BASE, profile: null, kind: 't24', channel: 'whatsapp' });
    expect(m.body).not.toContain('עם ');
    expect(m.body).toContain('דנה');
  });
});
