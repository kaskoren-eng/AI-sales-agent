import { describe, expect, it } from 'vitest';
import { DICTATION_NODS, isDictationTurn } from './dictation.js';
import { ACKNOWLEDGEMENTS_HE_WIDE } from './prompts/acknowledgements.he.js';

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

  it('every nod is short and none of them is a sentence', () => {
    // The whole point is that it does not close the caller's turn. If one of these ever grows a
    // verb, it has become a receipt again.
    for (const nod of DICTATION_NODS) {
      expect(nod.length, nod).toBeLessThanOrEqual(8);
    }
  });

  it('THE BANK IS HIS, VERBATIM — round-11 card `n1`, options C, F and L', () => {
    // *"אופציות מעולות שאני רוצה שנשתמש בכל אחת מהם באופן רנדומלי: C, F, L"* — all three, at random.
    // Byte-for-byte, INCLUDING the niqqud: two of these are inaudible or a different vowel without
    // it, and the marks only survive to Cartesia because speech-guard.ts exempts these exact
    // strings from the niqqud strip. If this literal is edited, a listening verdict must be quoted
    // in the same commit and the exemption re-checked — see speech-guard.test.ts.
    expect([...DICTATION_NODS]).toEqual(['אֶמ.', 'אהם.', 'אָה.']);
  });

  it('a nod is never a receipt — except the ONE he chose to be both, deliberately', () => {
    // Read out of the receipt bank rather than from a hand-written list, so a receipt that changes
    // spelling (round 10 moved two of the three) cannot slip past a stale literal here.
    //
    // `אֶמ.` IS the receipt `אמ.` with a segol on it, and that is not an oversight in either
    // direction: he chose `אמ.` for the receipt on round-10 card `f1` (heard inside a sentence) and
    // `אֶמ.` for the nod on round-11 card `n1` (heard alone), and the mark is the difference
    // between 1.04s of sound and 0.16s of near-silence when the sound stands on its own. Because
    // `openerKey` strips niqqud they are ONE key to the no-repeat rule, so a receipt on the
    // previous turn already blocks this nod on the next — which is the correct behaviour and is
    // pinned in spoken-openers.test.ts.
    const sameSoundAsAReceipt = ['אֶמ.'];
    for (const nod of DICTATION_NODS) {
      if (sameSoundAsAReceipt.includes(nod)) continue;
      for (const receipt of [...ACKNOWLEDGEMENTS_HE_WIDE]) {
        const stem = receipt.replace(/[.,!?…׃]/gu, '');
        expect(nod.replace(/[֑-ׇ]/gu, '').startsWith(stem), `${nod} / ${receipt}`).toBe(false);
      }
    }
  });
});
