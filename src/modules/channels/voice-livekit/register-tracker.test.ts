import { describe, expect, it } from 'vitest';
import {
  DRY_REPLIES_BEFORE_NUDGE,
  SpokenRegisterTracker,
  hasRegisterTouch,
} from './register-tracker.js';
import {
  EMOTIONAL_COLOR_DEVICES,
  REGISTER_VOCABULARY,
  SPOKEN_REGISTER_SLANG,
} from './prompts/system-prompt.he.js';

describe('the register vocabulary', () => {
  it('is the union of the two SCREENED banks — nothing enters without a phone-line test', () => {
    expect(REGISTER_VOCABULARY).toEqual([...SPOKEN_REGISTER_SLANG, ...EMOTIONAL_COLOR_DEVICES]);
  });

  it('contains וואלה, which the 2026-08-30 plan recorded as an invented word', () => {
    // It was not invented. It passed round 4b — the same listening screen that banned written
    // laughter — and EMOTIONAL_COLOR quotes it as the surprise device. She reached for an approved
    // word from the section next door; there was simply no name covering both banks.
    expect(REGISTER_VOCABULARY).toContain('וואלה');
  });
});

describe('hasRegisterTouch', () => {
  it('sees the two touches from the real call', () => {
    expect(hasRegisterTouch('זה אחלה לעסקים כמו שלך.')).toBe(true);
    expect(hasRegisterTouch('וואלה, מעניין.')).toBe(true);
  });

  it('matches through an attached Hebrew prefix — ובקטנה is the same word as בקטנה', () => {
    expect(hasRegisterTouch('ובקטנה אפשר להתחיל.')).toBe(true);
    expect(hasRegisterTouch('שסבבה מבחינתך.')).toBe(true);
  });

  it('ignores niqqud — the pronunciation fix vowels her speech and must not hide a touch', () => {
    // speech-numbers/guard add minimal niqqud (שלךָ, לוודֵא) on the way out. A metric that stopped
    // counting a vowelled word would drop touches for reasons that have nothing to do with register.
    expect(hasRegisterTouch('זה מְעוּלֶה')).toBe(true);
    expect(hasRegisterTouch('זה מעולה')).toBe(true);
  });

  it('is false for the formal register this section exists to prevent', () => {
    expect(hasRegisterTouch('אשמח שנתאם שיחת היכרות בהמשך השבוע.')).toBe(false);
  });
});

describe('SpokenRegisterTracker — the nudge', () => {
  const spaced = (t: SpokenRegisterTracker, lines: string[]): void => {
    lines.forEach((line, i) => t.observe(line, i * 60_000));
  };

  it('stays silent while she keeps the quota', () => {
    const t = new SpokenRegisterTracker();
    spaced(t, ['סבבה, נתקדם.', 'ספר לי על העסק.', 'זה אחלה בשבילך.']);
    expect(t.note()).toBeNull();
    expect(t.touched).toBe(2);
    expect(t.replies).toBe(3);
  });

  it('fires after two dry replies in a row, and names only the screened words', () => {
    const t = new SpokenRegisterTracker();
    spaced(t, ['ספר לי על העסק.', 'וכמה פניות נכנסות ביום?']);
    const note = t.note();
    expect(t.dryStreak).toBe(DRY_REPLIES_BEFORE_NUDGE);
    expect(note).toContain('never as the first word');
    for (const word of REGISTER_VOCABULARY) expect(note).toContain(word);
  });

  it('speaks ONCE per dry streak — a long formal stretch is not a note every turn', () => {
    const t = new SpokenRegisterTracker();
    spaced(t, ['אחת.', 'שתיים.']);
    expect(t.note()).not.toBeNull();
    expect(t.note()).toBeNull(); // same streak, same reply count — nothing new to say
    t.observe('שלוש.', 200_000);
    expect(t.note()).not.toBeNull(); // the streak grew; say so again
  });

  it('a touched reply resets the streak', () => {
    const t = new SpokenRegisterTracker();
    spaced(t, ['אחת.', 'שתיים.', 'סבבה, שלוש.']);
    expect(t.dryStreak).toBe(0);
    expect(t.note()).toBeNull();
  });

  it('ignores the preemptive-draft echo, which would halve the measured hit rate', () => {
    const t = new SpokenRegisterTracker();
    t.observe('סבבה, נתקדם.', 1_000);
    t.observe('סבבה, נתקדם.', 5_000);
    expect(t.replies).toBe(1);
    expect(t.touched).toBe(1);
  });

  it('THE 2026-08-29 SHAPE: two touches in eight turns produces a reminder', () => {
    const t = new SpokenRegisterTracker();
    spaced(t, [
      'קודם כל — איך קוראים לך?',
      'ספר לי קצת על העסק.',
      'זה אחלה לעסקים.',
      'וכמה פניות ביום?',
      'מי עונה להן היום?',
      'וואלה, מעניין.',
      'מה היית רוצה לשפר?',
      'בוא נקבע דמו קצר.',
    ]);
    expect(t.touched).toBe(2);
    expect(t.replies).toBe(8);
    expect(t.note()).not.toBeNull();
  });
});
