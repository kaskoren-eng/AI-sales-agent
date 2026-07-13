/**
 * Word Error Rate and Character Error Rate for Hebrew.
 *
 * WER = (substitutions + insertions + deletions) / words in the reference. It is the standard STT
 * accuracy measure. 0.0 is perfect; 1.0 means it got every word wrong; it can exceed 1.0 if the
 * engine hallucinates extra words, which Hebrew STT genuinely does.
 *
 * WHY CER TOO, AND WHY IT MATTERS MORE FOR HEBREW THAN FOR ENGLISH.
 * Hebrew glues its function words onto the front of the next word: "in the house" is one word,
 * בבית. So a model that hears בבית and writes ב בית has made a spacing mistake that WER scores as
 * TWO word errors — as bad as inventing a word outright. WER alone therefore overstates Hebrew
 * errors in a way it does not for English, and it would flatter whichever engine happens to
 * segment more conservatively. CER (the same edit distance over characters) sees that near-miss for
 * what it is. Report both; trust CER when they disagree on a near-miss.
 *
 * NORMALISATION IS WHERE A COMPARISON GETS RIGGED, so it is deliberately minimal and applied
 * IDENTICALLY to both engines: strip punctuation, collapse whitespace. Nothing else. We do NOT
 * strip Hebrew niqqud or normalise spelling variants, because that would quietly forgive real
 * errors — and the point of this exercise is to find out which engine makes fewer of them.
 */

/**
 * Punctuation to ignore. Includes the Hebrew geresh/gershayim and the maqaf (־), plus ASCII.
 * The ASCII hyphen is escaped: unescaped between – and ־ it forms a RANGE, and the whole regex
 * throws "Range out of order in character class" at import time.
 */
const PUNCT = /[.,!?;:"'`´‘’“”()[\]{}…—–\-־״׳]/gu;

export function normalize(text: string): string {
  return text.replace(PUNCT, ' ').replace(/\s+/gu, ' ').trim();
}

export function words(text: string): string[] {
  const n = normalize(text);
  return n === '' ? [] : n.split(' ');
}

/** Levenshtein distance over any token sequence. O(n*m) — fine at utterance length. */
export function editDistance<T>(a: T[], b: T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

export interface ErrorRates {
  wer: number;
  cer: number;
  refWords: number;
  hypWords: number;
  /** True when the engine returned nothing at all — a total failure, distinct from a bad guess. */
  empty: boolean;
}

export function errorRates(reference: string, hypothesis: string): ErrorRates {
  const ref = words(reference);
  const hyp = words(hypothesis);

  // An empty reference is a bug in the corpus, not a perfect score. Guard so a mistake there can
  // never show up as 0% WER and be mistaken for a flawless engine.
  if (ref.length === 0) {
    return { wer: hyp.length === 0 ? 0 : 1, cer: 0, refWords: 0, hypWords: hyp.length, empty: true };
  }

  const refChars = [...normalize(reference).replace(/ /gu, '')];
  const hypChars = [...normalize(hypothesis).replace(/ /gu, '')];

  return {
    wer: editDistance(ref, hyp) / ref.length,
    cer: refChars.length === 0 ? 0 : editDistance(refChars, hypChars) / refChars.length,
    refWords: ref.length,
    hypWords: hyp.length,
    empty: hyp.length === 0,
  };
}

// --- Number normalisation ----------------------------------------------------------------------
//
// WITHOUT THIS, THE A/B REPORTS THE OPPOSITE OF THE TRUTH.
//
// Soniox performs inverse text normalisation: it writes spoken numbers as DIGITS. Measured on our
// corpus, against a reference transcribed the way a person says it out loud:
//
//   reference  "אפס חמש שתיים, שלוש ארבע חמש, שש שבע שמונה תשע"
//   Soniox     "052-345-6789"          -> scored 76.9% WER. It is a PERFECT phone number.
//   OpenAI     "אפס חמש שתיים שלוש..."  -> scored 0% WER. It is a string of words to be parsed.
//
// Naive WER therefore punishes Soniox hardest exactly where it does the thing Phase 4 needs most:
// recovering a phone number and a booking time. Comparing the two engines on FORMATTING rather than
// MEANING would have led us to reject the better engine on the strength of a feature.
//
// So numbers are canonicalised on BOTH sides before scoring: Hebrew number-words become digits,
// digit strings lose their separators. What remains is a comparison of what was UNDERSTOOD.

const HEBREW_NUMERALS: Record<string, number> = {
  אפס: 0,
  אחת: 1, אחד: 1,
  שתיים: 2, שניים: 2, שתי: 2, שני: 2,
  שלוש: 3, שלושה: 3,
  ארבע: 4, ארבעה: 4,
  חמש: 5, חמישה: 5,
  שש: 6, שישה: 6,
  שבע: 7, שבעה: 7,
  שמונה: 8, שמונת: 8,
  תשע: 9, תשעה: 9,
  עשר: 10, עשרה: 10,
  עשרים: 20,
  שלושים: 30,
  ארבעים: 40,
  חמישים: 50,
};

/** Multipliers: "עשרים אלף" is 20 x 1000, not the two tokens 20 and 1000. */
const MULTIPLIERS: Record<string, number> = { מאה: 100, מאות: 100, אלף: 1000, אלפים: 1000 };

/** Hebrew glues single-letter prefixes on: "בשלוש" = ב + שלוש ("at three"). */
const PREFIXES = /^[בהולכמש]/u;

/**
 * Rewrites every number — spoken or written — into a bare digit form, on both sides of a
 * comparison, so two engines that UNDERSTOOD the same thing score the same regardless of how they
 * chose to write it down.
 */
export function canonicalizeNumbers(text: string): string {
  // Merge separators that sit BETWEEN digits, before normalize() turns them into spaces:
  // "052-345-6789" -> "0523456789", "20,000" -> "20000". Doing this after normalize would split the
  // number into pieces, and `Number("052")` is 52 — SILENTLY DESTROYING the leading zero of every
  // Israeli mobile number. Digit strings are never passed through Number() anywhere below.
  const merged = text.replace(/(\d)[\s,.–—-](?=\d)/gu, '$1');
  const toks = normalize(merged).split(' ').filter(Boolean);

  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i]!;

    // Already digits. Keep the string verbatim — leading zeros are data, not noise.
    if (/^\d+$/u.test(raw)) {
      out.push(raw);
      continue;
    }

    // A bare prefix letter stranded by normalize(): "ב-3" became "ב" + "3". The written form
    // "מחר ב-3" and the spoken form "מחר בשלוש" mean the same thing and must score the same.
    if (raw.length === 1 && PREFIXES.test(raw) && isNumberToken(toks[i + 1])) {
      continue;
    }

    const value = lookupNumeral(raw);
    if (value === null) {
      out.push(raw);
      continue;
    }

    // A multiplier folds into the number before it: "עשרים" then "אלף" is 20000, not 20 and 1000.
    const mult = MULTIPLIERS[stripPrefix(raw)];
    const prev = out[out.length - 1];
    if (mult !== undefined && prev !== undefined && /^\d+$/u.test(prev)) {
      out[out.length - 1] = String(Number(prev) * mult);
      continue;
    }
    out.push(String(value));
  }

  // A run of 3+ single digits is a phone number said aloud, not three separate quantities:
  // "0 5 2 3 4 5 6 7 8 9" is the same number as "0523456789".
  return joinDigitRuns(out).join(' ');
}

/** Is this token a number, written or spoken? Used to spot a prefix letter attached to one. */
function isNumberToken(token: string | undefined): boolean {
  if (token === undefined) return false;
  return /^\d+$/u.test(token) || lookupNumeral(token) !== null;
}

function lookupNumeral(token: string): number | null {
  const bare = stripPrefix(token);
  if (HEBREW_NUMERALS[bare] !== undefined) return HEBREW_NUMERALS[bare]!;
  if (MULTIPLIERS[bare] !== undefined) return MULTIPLIERS[bare]!;
  return null;
}

/** Tries the word as-is, then without a leading prefix letter — "בשלוש" -> "שלוש". */
function stripPrefix(token: string): string {
  if (HEBREW_NUMERALS[token] !== undefined || MULTIPLIERS[token] !== undefined) return token;
  return PREFIXES.test(token) ? token.slice(1) : token;
}

function joinDigitRuns(tokens: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };
  for (const t of tokens) {
    if (/^\d$/u.test(t)) run.push(t);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

/**
 * Error rates comparing MEANING rather than formatting: numbers are canonicalised on both sides
 * first. This is the number to judge the engines on — see the block comment above.
 */
export function semanticErrorRates(reference: string, hypothesis: string): ErrorRates {
  return errorRates(canonicalizeNumbers(reference), canonicalizeNumbers(hypothesis));
}

/** Mean of a list, or null for an empty one — never NaN, which would silently poison a report. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
