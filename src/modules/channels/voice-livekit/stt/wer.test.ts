import { describe, expect, it } from 'vitest';
import { canonicalizeNumbers, editDistance, errorRates, normalize, semanticErrorRates, words } from './wer.js';

/**
 * The scorer decides which engine wins, so a bug in it invents a result out of nothing. These tests
 * pin the arithmetic against cases where the right answer is countable by hand.
 */
describe('normalize', () => {
  it('strips punctuation and collapses whitespace', () => {
    expect(normalize('שלום,   מדבר יובל!')).toBe('שלום מדבר יובל');
  });

  it('strips the Hebrew maqaf, which STT engines emit inconsistently', () => {
    expect(words('אי־אפשר')).toEqual(['אי', 'אפשר']);
  });
});

describe('errorRates', () => {
  it('scores a perfect transcription as zero', () => {
    const r = errorRates('שלום מדבר יובל', 'שלום מדבר יובל');
    expect(r.wer).toBe(0);
    expect(r.cer).toBe(0);
  });

  it('scores one wrong word out of three as 1/3', () => {
    const r = errorRates('שלום מדבר יובל', 'שלום מדבר דניאל');
    expect(r.wer).toBeCloseTo(1 / 3);
  });

  it('ignores punctuation differences between reference and hypothesis', () => {
    expect(errorRates('שלום, מדבר יובל', 'שלום מדבר יובל').wer).toBe(0);
  });

  it('can exceed 1.0 when the engine hallucinates extra words — Hebrew STT really does this', () => {
    // A real call turned "השארתי פרטים" into "הייתי פרטימה", and line noise into the word "you".
    const r = errorRates('כן', 'כן you know what I mean');
    expect(r.wer).toBeGreaterThan(1);
  });

  it('flags an empty hypothesis rather than scoring it as merely bad', () => {
    // A dead engine and a wrong engine are different failures and must not average together.
    const r = errorRates('שלום מדבר יובל', '');
    expect(r.empty).toBe(true);
    expect(r.wer).toBe(1);
  });

  it('never scores an empty reference as a perfect 0% — that would be a corpus bug reading as a win', () => {
    const r = errorRates('', 'שלום');
    expect(r.empty).toBe(true);
    expect(r.wer).toBe(1);
  });

  it('CER sees a Hebrew prefix-splitting near-miss that WER calls a total loss', () => {
    // Hebrew glues prefixes on: "in the house" is one word, בבית. An engine that writes "ב בית"
    // is one space away from correct, but WER counts 2 word errors against a 1-word reference.
    const r = errorRates('בבית', 'ב בית');
    expect(r.wer).toBeGreaterThanOrEqual(1); // WER: brutal
    expect(r.cer).toBe(0); // CER: identical letters — it only got the spacing wrong
  });
});

/**
 * These are the real transcripts from the first A/B run. Without number canonicalisation the report
 * said Soniox was WORSE on business answers — while it was in fact the only engine that recovered
 * the phone number correctly. Naive WER punished it for writing "052-345-6789" instead of ten
 * Hebrew words. Judging engines on formatting instead of meaning would have rejected the better one.
 */
describe('canonicalizeNumbers — comparing meaning, not formatting', () => {
  it('turns a phone number said aloud into the same digits the engine wrote down', () => {
    const spoken = 'אפס חמש שתיים שלוש ארבע חמש שש שבע שמונה תשע';
    const written = '052-345-6789';
    expect(canonicalizeNumbers(spoken)).toBe(canonicalizeNumbers(written));
    expect(canonicalizeNumbers(written)).toContain('0523456789');
  });

  it('folds a multiplier: "עשרים אלף" is 20000, not the two numbers 20 and 1000', () => {
    expect(canonicalizeNumbers('עשרים אלף')).toBe('20000');
    expect(canonicalizeNumbers('20,000')).toBe('20000');
  });

  it('handles the glued Hebrew prefix: "בשלוש" ("at three") is 3', () => {
    expect(canonicalizeNumbers('מחר בשלוש')).toBe(canonicalizeNumbers('מחר ב-3'));
  });

  it('scores Soniox\'s digitised phone number as CORRECT, where naive WER called it 77% wrong', () => {
    const ref = 'המספר שלי הוא אפס חמש שתיים שלוש ארבע חמש שש שבע שמונה תשע';
    const soniox = 'המספר שלי הוא 052-345-6789';
    expect(errorRates(ref, soniox).wer).toBeGreaterThan(0.5); // the misleading number
    expect(semanticErrorRates(ref, soniox).wer).toBe(0); // the true one
  });

  it('does NOT forgive a genuinely wrong number', () => {
    const ref = 'אפס חמש שתיים שלוש ארבע חמש שש שבע שמונה תשע';
    const wrong = '052-345-6788'; // last digit off by one
    expect(semanticErrorRates(ref, wrong).wer).toBeGreaterThan(0);
  });

  it('leaves ordinary words alone', () => {
    expect(canonicalizeNumbers('שלום מדבר יובל')).toBe('שלום מדבר יובל');
  });
});

describe('editDistance', () => {
  it('counts substitutions, insertions and deletions', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1); // substitution
    expect(editDistance(['a', 'b'], ['a', 'b', 'c'])).toBe(1); // insertion
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1); // deletion
  });
});
