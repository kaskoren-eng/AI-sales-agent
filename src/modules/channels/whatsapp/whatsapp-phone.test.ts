import { describe, expect, it } from 'vitest';
import { toWhatsAppE164 } from './whatsapp.service.js';

/**
 * A real WhatsApp confirmation silently failed with Twilio 21211 because a voice lead's number was
 * sent as a LOCAL Israeli number ("0501111111") — Twilio needs E.164. These pin the normalization.
 */
describe('toWhatsAppE164', () => {
  it('turns a leading-zero Israeli mobile into +972', () => {
    expect(toWhatsAppE164('0501111111')).toBe('+972501111111');
    expect(toWhatsAppE164('050-123-4567')).toBe('+972501234567'); // spoken/typed with separators
    expect(toWhatsAppE164('054 987 6543')).toBe('+972549876543');
  });

  it('is idempotent for already-E.164 numbers', () => {
    expect(toWhatsAppE164('+972509788845')).toBe('+972509788845');
    expect(toWhatsAppE164('+972-50-978-8845')).toBe('+972509788845');
  });

  it('adds the plus to a 972-prefixed number', () => {
    expect(toWhatsAppE164('972509788845')).toBe('+972509788845');
  });

  it('adds the country code to a bare 9-digit mobile', () => {
    expect(toWhatsAppE164('509788845')).toBe('+972509788845');
  });

  it('leaves an unrecognized/foreign number untouched — let Twilio surface the error', () => {
    expect(toWhatsAppE164('+14155550123')).toBe('+14155550123');
  });
});
