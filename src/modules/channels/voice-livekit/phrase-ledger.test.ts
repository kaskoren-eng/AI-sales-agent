import { describe, expect, it } from 'vitest';
import { PhraseLedger, countRepeatedFourGrams, ledgerTokens, countRepeatedOpeners, leadingOpener } from './phrase-ledger.js';

/** Observations spaced far enough apart that the draft-echo dedupe never confuses a test. */
const SPACED = (ledger: PhraseLedger, texts: string[]): void => {
  texts.forEach((t, i) => ledger.observe(t, i * 60_000));
};

describe('ledgerTokens — a phrasing is words, not punctuation or pointing', () => {
  it('strips punctuation and niqqud, splits on whitespace', () => {
    expect(ledgerTokens('מה השם שלךָ, בבקשה?')).toEqual(['מה', 'השם', 'שלך', 'בבקשה']);
  });
});

describe('PhraseLedger — repetition is detected at the 4-gram level', () => {
  it('a fresh call has nothing to say — the common case costs nothing', () => {
    const l = new PhraseLedger();
    SPACED(l, ['שלום, מדברת קרן מקליקסקיילס ואשמח לעזור.']);
    expect(l.note()).toBeNull();
    expect(l.repeatedGramCount).toBe(0);
  });

  it('the same phrasing in two different replies triggers the note', () => {
    const l = new PhraseLedger();
    SPACED(l, [
      'נשמע מעולה, בוא נקבע שיחת דמו קצרה השבוע.',
      'אין בעיה. בוא נקבע שיחת דמו קצרה ליום שני.',
    ]);
    expect(l.repeatedGramCount).toBeGreaterThan(0);
    expect(l.note()).toContain('נקבע שיחת דמו קצרה');
  });

  it('overlapping repeated 4-grams are MERGED into one readable phrase, not a token soup', () => {
    const l = new PhraseLedger();
    const sentence = 'איזה עסק יש לך ומה אתה מוכר בדיוק?';
    SPACED(l, [sentence, sentence]);
    // One merged phrase covering the whole repeated span — not five staggered fragments.
    const note = l.note()!;
    expect(note).toContain('«איזה עסק יש לך ומה אתה מוכר בדיוק»');
    expect(note.match(/«/gu)!.length).toBe(1);
  });

  it('DRAFT-ECHO DEDUPE: ConversationItemAdded fires twice per reply — the echo is not a repeat', () => {
    const l = new PhraseLedger();
    const reply = 'נשמע שממש מתאים למה שאנחנו עושים היום.';
    l.observe(reply, 1_000); // the preemptive draft
    l.observe(reply, 2_500); // the confirmed item, same text, seconds later
    expect(l.note()).toBeNull();
    // But the SAME sentence a minute later is a genuine repetition.
    l.observe(reply, 90_000);
    expect(l.note()).not.toBeNull();
  });

  it('tracked words (the slang bank) join the note on their second use', () => {
    const l = new PhraseLedger(['סבבה', 'אחלה']);
    SPACED(l, ['סבבה, אז נתקדם לשאלה הבאה.', 'סבבה, מתי נוח לך לדבר?']);
    expect(l.note()).toContain('«סבבה»');
  });

  it('a tracked word used once is not nagged about', () => {
    const l = new PhraseLedger(['סבבה']);
    SPACED(l, ['סבבה, אז נתקדם.']);
    expect(l.note()).toBeNull();
  });

  it('the note is capped and keeps the most recent repeats', () => {
    const l = new PhraseLedger();
    const sentences: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = `משפט חוזר מספר ${i} שאומרים אותו פעמיים ברצף כאן.`;
      sentences.push(s, s);
    }
    SPACED(l, sentences);
    const note = l.note()!;
    expect(note.match(/«/gu)!.length).toBeLessThanOrEqual(8);
    expect(note).toContain('11'); // the most recent repeat made the cut
  });

  it('niqqud and punctuation differences do not hide a repetition', () => {
    const l = new PhraseLedger();
    SPACED(l, ['מה השם המלא שלךָ, בבקשה?', 'מה השם המלא שלך בבקשה!']);
    expect(l.note()).not.toBeNull();
  });
});

describe('countRepeatedFourGrams — the CallReport metric and the backfill share this', () => {
  it('zero on a varied call', () => {
    expect(
      countRepeatedFourGrams([
        'שלום, מדברת קרן מקליקסקיילס.',
        'איזה עסק יש לך בדיוק?',
        'מעולה, נקבע דמו קצר מחר.',
      ]),
    ).toBe(0);
  });

  it('counts DISTINCT repeated 4-grams, once each, however many times they recur', () => {
    const line = 'אחת שתיים שלוש ארבע';
    expect(countRepeatedFourGrams([line, line, line])).toBe(1);
  });

  it('a longer repeated phrase counts each of its 4-grams — the §4 currency (up to 62/call)', () => {
    const line = 'אחת שתיים שלוש ארבע חמש שש';
    expect(countRepeatedFourGrams([line, line])).toBe(3);
  });
});

/**
 * THE METRIC THAT STAYED GREEN THROUGH THE DEFECT IT EXISTS TO CATCH.
 *
 * 2026-08-29: `repeatedPhraseCount: 0`, six of eight turns opening with `אהה.` / `בסדר.` /
 * `אוקיי.`, two uses each. Nothing was wrong with the 4-gram count — this is what it could not see.
 */
describe('countRepeatedOpeners', () => {
  const call = [
    'אהה. קודם כל — איך קוראים לךָ?',
    'בסדר. ספר לי קצת על העסק שלך.',
    'אוקיי. וכמה פניות נכנסות ביום?',
    'אהה. מי עונה להן היום?',
    'בסדר. ומה היית רוצה לשפר?',
    'אוקיי. אז בוא נקבע דמו קצר.',
    'מעולה. מחר בעשר מתאים לך?',
    'נהדר. שלחתי לך אישור.',
  ];

  it('reports 3 on the real call the 4-gram counter reported 0 for', () => {
    expect(countRepeatedFourGrams(call)).toBe(0);
    expect(countRepeatedOpeners(call)).toBe(3);
  });

  it('counts DISTINCT openers, not occurrences — same currency as the 4-gram count', () => {
    expect(countRepeatedOpeners(['אוקיי. א', 'אוקיי. ב', 'אוקיי. ג'])).toBe(1);
  });

  it('a line with no punctuated opener contributes nothing', () => {
    expect(countRepeatedOpeners(['אני בודקת את זה עכשיו', 'אני בודקת את זה עכשיו'])).toBe(0);
  });

  it('reads the opener whether it is followed by a period or a comma', () => {
    expect(leadingOpener('אוקיי. אז נתקדם.')).toBe('אוקיי');
    expect(leadingOpener('אוקיי, אז נתקדם.')).toBe('אוקיי');
    expect(leadingOpener('אז נתקדם אוקיי')).toBeNull();
  });

  it('ignores niqqud, so a vowelled opener is the same opener', () => {
    expect(countRepeatedOpeners(['בסדר. שלךָ', 'בסדר. לוודֵא'])).toBe(1);
  });

  it('does not treat a leading number as an opener', () => {
    expect(countRepeatedOpeners(['10. ככה', '10. ככה אחרת'])).toBe(0);
  });
});
