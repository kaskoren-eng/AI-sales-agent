import { describe, expect, it } from 'vitest';
import { normalizeSpokenNumbers } from './speech-numbers.he.js';

/**
 * The normalizer is deterministic, so the tests are a TABLE — the same table the round-5
 * listening/Soniox verification runs against. If a form fails by ear, it changes HERE first.
 */

describe('clock times — colloquial feminine hours (Koren, 2026-08-27)', () => {
  const CASES: Array<[string, string]> = [
    // The complaint verbatim: HH:30 is "וחצי" on the 12-hour feminine clock.
    ['16:30', 'ארבע וחצי'],
    ['16:00', 'ארבע'],
    ['10:00', 'עשר'],
    ['16:15', 'ארבע ורבע'],
    // :45 counts DOWN to the next hour.
    ['16:45', 'רבע לחמש'],
    ['11:45', 'רבע לשתים עשרה'],
    ['23:45', 'רבע לשתים עשרה'],
    ['12:45', 'רבע לאחת'],
    // So do :50 and :55 — "ארבע חמישים וחמישה" is not a thing anyone says.
    ['16:50', 'עשרה לחמש'],
    ['16:55', 'חמישה לחמש'],
    // Other minutes: hour + ו + colloquial masculine minute words.
    ['16:20', 'ארבע ועשרים'],
    ['10:05', 'עשר וחמישה'],
    ['10:10', 'עשר ועשרה'],
    ['14:25', 'שתיים עשרים וחמישה'],
    ['09:40', 'תשע וארבעים'],
    // Noon and midnight are both שתים עשרה on a 12-hour clock.
    ['12:30', 'שתים עשרה וחצי'],
    ['00:30', 'שתים עשרה וחצי'],
    ['13:00', 'אחת'],
    ['22:30', 'עשר וחצי'],
  ];

  it.each(CASES)('%s → %s', (digits, words) => {
    expect(normalizeSpokenNumbers(digits)).toBe(words);
  });

  it('keeps an attached prefix, dropping its hyphen: "ב-16:30" → "בארבע וחצי"', () => {
    expect(normalizeSpokenNumbers('נתראה ב-16:30, טוב?')).toBe('נתראה בארבע וחצי, טוב?');
    expect(normalizeSpokenNumbers('אפשר מ-10:00')).toBe('אפשר מעשר');
    expect(normalizeSpokenNumbers('עד 15:00 אני פנויה')).toBe('עד שלוש אני פנויה');
  });

  it('a range converts BOTH ends: "מ-10:00 עד 15:00" → "מעשר עד שלוש"', () => {
    expect(normalizeSpokenNumbers('יש לי פנוי מ-10:00 עד 15:00, איזו שעה מתאימה?')).toBe(
      'יש לי פנוי מעשר עד שלוש, איזו שעה מתאימה?',
    );
  });

  it('a dashed range becomes "עד" — hyphen and en-dash alike', () => {
    expect(normalizeSpokenNumbers('פנוי 10:00-12:00')).toBe('פנוי עשר עד שתים עשרה');
    expect(normalizeSpokenNumbers('פנוי 10:00–12:00')).toBe('פנוי עשר עד שתים עשרה');
  });

  it('two windows, all four times converted', () => {
    expect(normalizeSpokenNumbers('מ-10:00 עד 12:00, ומ-14:00 עד 16:00')).toBe(
      'מעשר עד שתים עשרה, ומשתיים עד ארבע',
    );
  });
});

describe('clock times — the daypart heuristic is CONSERVATIVE', () => {
  it('a lone evening hour gets בערב — the one genuinely confusable direction', () => {
    expect(normalizeSpokenNumbers('נדבר ב-20:00')).toBe('נדבר בשמונה בערב');
    expect(normalizeSpokenNumbers('אפשר ב-19:30')).toBe('אפשר בשבע וחצי בערב');
  });

  it('daytime hours get NOTHING — context carries it', () => {
    expect(normalizeSpokenNumbers('נדבר ב-09:00')).toBe('נדבר בתשע');
    expect(normalizeSpokenNumbers('נדבר ב-16:30')).toBe('נדבר בארבע וחצי');
  });

  it('never inside a range — "מ-18:00 עד 20:00" needs no daypart', () => {
    expect(normalizeSpokenNumbers('מ-18:00 עד 20:00')).toBe('משש עד שמונה');
  });

  it('never doubled when the sentence already names one', () => {
    expect(normalizeSpokenNumbers('נדבר ב-20:00 בערב')).toBe('נדבר בשמונה בערב');
  });
});

describe('phone numbers — digit-by-digit, feminine, with grouping pauses', () => {
  it('the prompt example, enforced in code: "050-1234567"', () => {
    expect(normalizeSpokenNumbers('המספר הוא 050-1234567, נכון?')).toBe(
      'המספר הוא אפס חמש אפס, אחת שתיים שלוש ארבע, חמש שש שבע, נכון?',
    );
  });

  it('an unbroken mobile number gets the same grouping', () => {
    expect(normalizeSpokenNumbers('0501234567')).toBe(
      'אפס חמש אפס, אחת שתיים שלוש ארבע, חמש שש שבע',
    );
  });

  it('a landline with a 2-digit prefix', () => {
    expect(normalizeSpokenNumbers('03-1234567')).toBe(
      'אפס שלוש, אחת שתיים שלוש ארבע, חמש שש שבע',
    );
  });

  it('a fragmented partial ("888-45.") is NOT a phone and stays untouched', () => {
    expect(normalizeSpokenNumbers('888-45.')).toBe('888-45.');
  });
});

describe('prices — round shapes only, everything else untouched', () => {
  it.each([
    ['זה עולה 500 שקל לחודש', 'זה עולה חמש מאות שקל לחודש'],
    ['בערך 200 שקלים', 'בערך מאתיים שקלים'],
    ['1000 ש"ח', 'אלף ש"ח'],
    ['5000 שקל', 'חמשת אלפים שקל'],
    ['10000 שקל', 'עשרת אלפים שקל'],
  ])('%s → %s', (digits, words) => {
    expect(normalizeSpokenNumbers(digits)).toBe(words);
  });

  it('a non-round amount is DELIBERATELY untouched — untouched beats wrong', () => {
    expect(normalizeSpokenNumbers('1250 שקל')).toBe('1250 שקל');
    expect(normalizeSpokenNumbers('117 שקל')).toBe('117 שקל');
  });
});

describe('small integers — feminine by default, masculine only before the curated nouns', () => {
  it.each([
    ['5 דקות', 'חמש דקות'],
    ['15 דקות', 'חמש עשרה דקות'],
    ['3 שעות', 'שלוש שעות'],
    ['2 שאלות', 'שתיים שאלות'],
    ['3 ימים', 'שלושה ימים'],
    ['3 ימים.', 'שלושה ימים.'],
    ['2 שבועות', 'שני שבועות'],
    ['10 אחוז', 'עשרה אחוז'],
  ])('%s → %s', (digits, words) => {
    expect(normalizeSpokenNumbers(digits)).toBe(words);
  });

  it('a date before a month name is skipped outright', () => {
    expect(normalizeSpokenNumbers('ב-3 באוקטובר')).toBe('ב-3 באוקטובר');
  });

  it('numbers above 19 are not its business', () => {
    expect(normalizeSpokenNumbers('רחוב הרצל 25')).toBe('רחוב הרצל 25');
    expect(normalizeSpokenNumbers('שנת 2026')).toBe('שנת 2026');
  });
});

describe('safety properties', () => {
  it('idempotent — normalizing twice is the same as once', () => {
    for (const s of [
      'נתראה ב-16:30',
      'מ-10:00 עד 15:00',
      '050-1234567',
      '500 שקל ו-5 דקות',
      'נדבר ב-20:00',
    ]) {
      const once = normalizeSpokenNumbers(s);
      expect(normalizeSpokenNumbers(once)).toBe(once);
    }
  });

  it('digit-free text passes through by reference-equal fast path', () => {
    const s = 'שלום, מדברת קרן מקליקסקיילס.';
    expect(normalizeSpokenNumbers(s)).toBe(s);
  });
});
