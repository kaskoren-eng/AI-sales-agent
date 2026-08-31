import { describe, expect, it } from 'vitest';
import {
  NameDictation,
  joinHebrewLetters,
  nameReadback,
  spelledNameLetters,
} from './name-dictation.js';

/**
 * THE SURNAME, REPLAYED FROM THE CALL REPORT — 2026-08-31 16:51, verbatim.
 * His name is `שטרית`. She ended the call with «שפיץ טריט».
 */
const replay = (): NameDictation => {
  const d = new NameDictation();
  const her = (t: string, at: number) => d.observeAgentUtterance(t, at);
  const him = (t: string, at: number) => d.observeCallerUtterance(t, at);
  her('בסדר. קבענו לאחת עשרה. קורן, מה השם המלא שלךָ?', 273_000);
  him('אממ, יש לי.  טריט.', 278_000);
  her('בסדר. איך מאייתים את שם המשפחה?', 282_000);
  him('עם ט-ר.  י.', 287_000);
  him('ת.', 288_000);
  return d;
};

describe('spelledNameLetters — the isolated-letter rule, which is the whole Hebrew problem', () => {
  it('pulls the spelled letters out of his turns and leaves the ordinary words alone', () => {
    // "עם" is two ADJACENT Hebrew letters, so it is a word; ט, ר and י each stand alone.
    expect(spelledNameLetters('עם ט-ר.  י.')).toEqual(['ט', 'ר', 'י']);
    expect(spelledNameLetters('ת.')).toEqual(['ת']);
  });

  it('takes nothing from ordinary Hebrew, however short the words are', () => {
    for (const line of [
      'אני קורן.',
      'לא, את לא צריכה מספר טלפון.',
      'שפיץ.  טריט.',
      'מה השם משפחה שרשמת?',
      'אני עובד עם CRM ועם AI.',
    ]) {
      expect(spelledNameLetters(line), line).toEqual([]);
    }
  });

  it('reads Latin spelling too, in the order it was said', () => {
    expect(spelledNameLetters('S. H. T. R. I. T.')).toEqual(['S', 'H', 'T', 'R', 'I', 'T']);
  });
});

describe('joinHebrewLetters — a name a person could read back', () => {
  it('joins them in order', () => {
    expect(joinHebrewLetters(['ט', 'ר', 'י', 'ת'])).toBe('טרית');
  });

  it('a man spelling כץ says צ and means ץ — the last letter takes its final form', () => {
    expect(joinHebrewLetters(['כ', 'צ'])).toBe('כץ');
    expect(joinHebrewLetters(['ש', 'ט', 'ר', 'י', 'ת'])).toBe('שטרית');
  });

  it('a final form said mid-word is written as the ordinary one', () => {
    expect(joinHebrewLetters(['ם', 'ר', 'ן'])).toBe('מרן');
  });
});

describe('NameDictation — replaying the call that lost the surname', () => {
  it('stitches ט · ר · י · ת across the two turns the endpointer cut it into', () => {
    // Nothing joined these on the call. Her next words were the garbled word she already had.
    expect(replay().snapshot().letters).toEqual(['ט', 'ר', 'י', 'ת']);
  });

  it('the note hands the model the joined name and tells it to read THAT back', () => {
    const note = replay().note() ?? '';
    expect(note).toContain('ט ר י ת');
    expect(note).toContain('«טרית»');
    expect(note).toMatch(/ONE name read out in pieces/u);
    expect(note).toMatch(/rather than the word you thought you heard/u);
  });

  it('two readings of one name are competing mishearings, never a first and a last name', () => {
    // [294s] "טריט, נכון?"  →  [320s] "שפיץ טריט, נכון?"  — she joined two garbled fragments.
    const d = replay();
    d.observeAgentUtterance('אוקי. טריט, נכון? מה מספר הטלפון שלךָ?', 294_000);
    d.observeAgentUtterance('אוקי. השם משפחה הוא שפיץ?', 331_000);
    const note = d.note() ?? '';
    expect(note).toContain('«טריט»');
    expect(note).toContain('«שפיץ»');
    expect(note).toMatch(/competing mishearings of the SAME word/u);
    expect(note).toMatch(/Do not join them together/u);
  });

  it('a name he says is wrong is reported to the caller, for fact memory to refuse', () => {
    const d = new NameDictation();
    d.observeAgentUtterance('אוקי. שפיץ טריט, נכון? ומה כתובת המייל?', 320_000);
    expect(d.observeCallerUtterance('לא.', 320_500)).toBe('שפיץ טריט');
    expect(d.snapshot().rejected).toEqual(['שפיץ טריט']);
  });

  it('a rejection RESETS the letter buffer — a wrong reading must not concatenate onto the right one', () => {
    const d = new NameDictation();
    d.observeAgentUtterance('איך מאייתים את שם המשפחה?', 1000);
    d.observeCallerUtterance('ט-ר-י-ת.', 2000);
    d.observeAgentUtterance('טרית, נכון?', 3000);
    d.observeCallerUtterance('לא נכון.', 4000);
    expect(d.snapshot().letters).toEqual([]);
  });
});

describe('NameDictation — the bounds that keep a stateful classifier from getting stuck', () => {
  it('collects nothing until she has asked for the name or its spelling', () => {
    const d = new NameDictation();
    d.observeCallerUtterance('עם ט-ר.  י.', 1000);
    expect(d.snapshot().letters).toEqual([]);
    expect(d.note()).toBeNull();
  });

  it('"איך מאייתים" opens the window — the question she actually asked', () => {
    const d = new NameDictation();
    d.observeAgentUtterance('בסדר. איך מאייתים את שם המשפחה?', 1000);
    expect(d.snapshot().collecting).toBe(true);
  });

  it('a confirmation closes it, so a stray letter later cannot reopen the field', () => {
    const d = new NameDictation();
    d.observeAgentUtterance('איך מאייתים את שם המשפחה?', 1000);
    d.observeCallerUtterance('ש-ט-ר-י-ת.', 2000);
    d.observeAgentUtterance('שטרית, נכון?', 3000);
    d.observeCallerUtterance('כן, נכון.', 4000);
    expect(d.snapshot().collecting).toBe(false);
    expect(d.note()).toBeNull();
  });

  it('the preemptive-draft echo arrives twice and is counted once', () => {
    const d = new NameDictation();
    d.observeAgentUtterance('איך מאייתים את שם המשפחה?', 1000);
    d.observeCallerUtterance('ט-ר-י-ת.', 2000);
    d.observeCallerUtterance('ט-ר-י-ת.', 2100); // the same committed item, delivered again
    expect(d.snapshot().letters).toEqual(['ט', 'ר', 'י', 'ת']);
  });

  it('holds at most MAX_NAME_LETTERS however long the spelling runs', () => {
    const d = new NameDictation();
    d.observeAgentUtterance('איך מאייתים את שם המשפחה?', 1000);
    for (let i = 0; i < 40; i++) d.observeCallerUtterance(`א-ב-ג-ד. ${i}`, 2000 + i * 100);
    expect(d.snapshot().letters.length).toBeLessThanOrEqual(24);
  });
});

describe('nameReadback — what she just proposed as his name', () => {
  it('reads it out of both shapes she used on the call', () => {
    expect(nameReadback('אוקי. טריט, נכון? מה מספר הטלפון שלךָ?')).toBe('טריט');
    expect(nameReadback('אוקי. שפיץ טריט, נכון? ומה כתובת המייל?')).toBe('שפיץ טריט');
    expect(nameReadback('אוקי. השם משפחה הוא שפיץ?')).toBe('שפיץ');
  });

  it('is null for a sentence that proposes nothing', () => {
    expect(nameReadback('מה מספר הטלפון שלךָ?')).toBeNull();
    expect(nameReadback('בסדר. איך מאייתים את שם המשפחה?')).toBeNull();
  });
});
