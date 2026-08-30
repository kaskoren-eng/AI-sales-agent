import { describe, expect, it } from 'vitest';
import { DICTATION_NOD, isDictationTurn } from './dictation.js';

/**
 * The regression net for the 2026-08-30 production call: he said "050-", she answered
 * "טוב, הבנתי." as a complete sentence, and he read the other seven digits into it. Every
 * utterance below is taken verbatim from that call's transcript unless marked otherwise, because
 * the classifier only has to be right about the Hebrew people actually speak into a phone.
 */
describe('isDictationTurn — is the caller reading something out?', () => {
  it('catches the turn that produced the bug — a phone number left hanging', () => {
    expect(isDictationTurn('050-')).toBe(true);
    expect(isDictationTurn('9788845.')).toBe(true);
  });

  it('catches a whole number said in one go, however it is grouped', () => {
    expect(isDictationTurn('050 978 8845')).toBe(true);
    expect(isDictationTurn('0509788845')).toBe(true);
    expect(isDictationTurn('052-345-6789')).toBe(true);
  });

  it('catches an email said the way Israelis say one on the phone', () => {
    expect(isDictationTurn("הכתובת היא קורן שטרודל ג'ימייל נקודה קום.")).toBe(true);
    expect(isDictationTurn('קורן שטרודל גימייל נקודה קום')).toBe(true);
    expect(isDictationTurn('koren@gmail.com')).toBe(true);
  });

  it('catches letters being spelled out', () => {
    expect(isDictationTurn('זה K-A-S.')).toBe(true);
    expect(isDictationTurn('קורן, K-O-R-E-N, שטרודל ג׳ימייל נקודה קום.')).toBe(true);
  });

  it('leaves ordinary conversation alone — a nod there would be the new bug', () => {
    // Every one of these is a real caller turn from the two 2026-08-30 calls.
    expect(isDictationTurn('היי קרן, מה נשמע? אני מדבר קורן.')).toBe(false);
    expect(isDictationTurn('אני מתעסק בבניית אתרים.')).toBe(false);
    expect(isDictationTurn('פייסבוק, אינסטגרם.')).toBe(false);
    expect(isDictationTurn('כן, כן.')).toBe(false);
    expect(isDictationTurn('שטרית.')).toBe(false);
    // "הסוכן הזה הוא פעיל 24/7" — digits, and not a dictation.
    expect(isDictationTurn('הסוכן הזה הוא פעיל 24/7.')).toBe(false);
    expect(isDictationTurn('אני מוציא בערך 20 אלף בחודש על שיווק.')).toBe(false);
    expect(isDictationTurn('זה עולה בערך 500 שקל?')).toBe(false);
  });

  it('never nods through a QUESTION, even one full of digits', () => {
    // He is asking. A nod leaves him waiting for an answer that has not started.
    expect(isDictationTurn('אז זה 050-9788845, נכון?')).toBe(false);
    expect(isDictationTurn('כמה זה עולה, 500 לחודש?')).toBe(false);
  });

  it('is false for nothing at all — the first turn of a call has no previous utterance', () => {
    expect(isDictationTurn(null)).toBe(false);
    expect(isDictationTurn(undefined)).toBe(false);
    expect(isDictationTurn('   ')).toBe(false);
  });

  it('the nod is short and is not a sentence', () => {
    // The whole point is that it does not close the caller's turn. If this ever grows a verb,
    // it has become a receipt again.
    expect(DICTATION_NOD.length).toBeLessThanOrEqual(8);
    expect(DICTATION_NOD).not.toMatch(/הבנתי|אוקיי|בסדר/u);
  });
});
