/**
 * Hebrew number & time SPEECH normalizer — digits become the words a person would say.
 *
 * Koren, 2026-08-27, after live calls: "16:30" came out as raw digits — the TTS does not know how
 * to say an hour in Hebrew, and the prompt asking for colloquial times is guidance the model
 * forgets under context load (the MAX_FILLERS lesson: prompt instructions degrade; code enforces).
 * So the colloquial form is enforced HERE, in the speech path, where it cannot be forgotten.
 *
 * SPEECH-ONLY, same contract as the gender tables and PRONUNCIATION_FIXES: this rewrites only the
 * text handed to the TTS. The transcript, chatCtx and CallReport keep the digits — which is also
 * why this cannot live in the calendar tool's output: words returned to the LLM would be echoed
 * into the transcript, and the slot_datetime verbatim-echo contract needs machine format.
 *
 * THE GENDER RULES ARE THE WHOLE DIFFICULTY, and the scope is deliberately narrow:
 *   - Clock hours are FEMININE ("ארבע וחצי", never "ארבעה וחצי").
 *   - Minutes are the colloquial MASCULINE forms ("עשר וחמישה", "ארבע ועשרים") — that is how
 *     Israelis actually say clock minutes, normative grammar notwithstanding.
 *   - Phone digits are read digit-by-digit in the FEMININE ("אפס חמש אפס..."), with grouping
 *     pauses, which is what the prompt already asks for and the model forgets.
 *   - Bare small integers default FEMININE (the counting form), flipped to masculine only before
 *     a small curated masculine-noun list. Full Hebrew noun-gender agreement is a non-goal:
 *     UNTOUCHED BEATS WRONG, so anything outside the curated patterns passes through as digits.
 *   - Prices cover only the round shapes that occur in this call flow (hundreds, round thousands).
 *     The construct-state minefield (1,250 ₪, agorot, millions) is deliberately not entered.
 *
 * Runs per flushed SENTENCE inside guardSpeech — never on token fragments — so a time can never
 * be half-converted across a chunk boundary (guardStream's sentenceEnd already refuses to split
 * at a mark without trailing whitespace, e.g. inside "10:30").
 */

/** Feminine cardinal — clock hours and standalone counting. Index = value. */
const FEM_UNITS = [
  'אפס', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר',
  'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה', 'חמש עשרה', 'שש עשרה', 'שבע עשרה',
  'שמונה עשרה', 'תשע עשרה',
] as const;

/** Masculine cardinal 1–19 — used before the curated masculine nouns. */
const MASC_UNITS = [
  'אפס', 'אחד', 'שני', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה', 'עשרה',
  'אחד עשר', 'שנים עשר', 'שלושה עשר', 'ארבעה עשר', 'חמישה עשר', 'שישה עשר', 'שבעה עשר',
  'שמונה עשר', 'תשעה עשר',
] as const;

/** Tens for minute compounds (20–50). */
const TENS = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים'] as const;

/** A clock HOUR, colloquial 12-hour feminine word. 0/12 → שתים עשרה, 13–23 → 1–11. */
function hourWord(h24: number): string {
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return FEM_UNITS[h12]!;
}

/**
 * Colloquial minute words for the "hour + minutes" form. Masculine, the way clock minutes are
 * actually spoken: 5 → "וחמישה", 20 → "ועשרים", 25 → "עשרים וחמישה" (no leading ו — a double
 * "ו...ו" reads badly). 15/30/45/50/55 never reach here — they have their own shapes.
 */
function minuteWords(mm: number): string {
  if (mm < 10) return `ו${MASC_UNITS[mm]}`;
  if (mm < 20) return `ו${MASC_UNITS[mm]}`;
  const tens = TENS[Math.floor(mm / 10)]!;
  const unit = mm % 10;
  if (unit === 0) return `ו${tens}`;
  return `${tens} ו${MASC_UNITS[unit]}`;
}

/**
 * One clock time → colloquial Hebrew words. Hours are feminine; the special minute shapes are the
 * ones Israelis use: bare hour, ורבע, וחצי, רבע ל, and the "X ל" countdown for :50/:55 (the same
 * pattern as רבע ל — "ארבע חמישים וחמישה" is not a thing anyone says).
 */
function timeToWords(h24: number, mm: number): string {
  const nextHour = (): string => hourWord((h24 + 1) % 24);
  if (mm === 0) return hourWord(h24);
  if (mm === 15) return `${hourWord(h24)} ורבע`;
  if (mm === 30) return `${hourWord(h24)} וחצי`;
  if (mm === 45) return `רבע ל${nextHour()}`;
  if (mm === 50) return `עשרה ל${nextHour()}`;
  if (mm === 55) return `חמישה ל${nextHour()}`;
  return `${hourWord(h24)} ${minuteWords(mm)}`;
}

/** Words that already anchor a time of day — their presence suppresses the daypart heuristic. */
const DAYPART_WORDS = /בבוקר|בצהריים|אחר הצהריים|אחה"צ|אחה״צ|בערב|בלילה|לפנות בוקר/u;

/** Range markers — a range never gets a daypart word ("מ-10:00 עד 15:00" needs none). */
const RANGE_MARKERS = /\bעד\b|\bבין\b|לבין/u;

/** Feminine digit names for phone read-out. */
const PHONE_DIGITS = FEM_UNITS.slice(0, 10);

/** Nouns that take the MASCULINE cardinal — small and curated; everything else stays feminine
 * (the common flow nouns — דקות, שעות, פעמים — are feminine, which is the default already). */
const MASCULINE_NOUNS = /^(?:ימים|שבועות|חודשים|אחוז|אחוזים)$/u;

/** Month names — "ב-3 באוקטובר" is a DATE (masculine ordinal territory), not a count. Skip it. */
const MONTHS =
  /^ב?(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)$/u;

/** Hundreds 100–900 (feminine base — the normative price form) and round thousands 1000–10000. */
const PRICE_WORDS: Record<number, string> = {
  100: 'מאה', 200: 'מאתיים', 300: 'שלוש מאות', 400: 'ארבע מאות', 500: 'חמש מאות',
  600: 'שש מאות', 700: 'שבע מאות', 800: 'שמונה מאות', 900: 'תשע מאות',
  1000: 'אלף', 2000: 'אלפיים', 3000: 'שלושת אלפים', 4000: 'ארבעת אלפים', 5000: 'חמשת אלפים',
  6000: 'ששת אלפים', 7000: 'שבעת אלפים', 8000: 'שמונת אלפים', 9000: 'תשעת אלפים',
  10000: 'עשרת אלפים',
};

/**
 * Phone-shaped digit runs: starts with 0, at least 8 digits total, optionally split by hyphens or
 * spaces ("050-1234567", "05012 34567", "03-1234567"). Bounded on both sides so it never eats a
 * neighbouring number.
 */
const PHONE_RE = /(?<![\d:.-])0\d{1,2}(?:[- ]?\d){7,9}(?![\d:])/gu;

/** Chunks a digit string into speakable groups of 3–4, honouring any separators already present. */
function phoneToWords(raw: string): string {
  const groups: string[] = [];
  for (const part of raw.split(/[- ]/u).filter(Boolean)) {
    if (part.length <= 4) {
      groups.push(part);
      continue;
    }
    // An unbroken long run: peel the dialing prefix (05X / 0X), then 4+rest.
    let rest = part;
    if (rest.startsWith('0')) {
      const prefixLen = rest.length >= 10 ? 3 : 2;
      groups.push(rest.slice(0, prefixLen));
      rest = rest.slice(prefixLen);
    }
    while (rest.length > 4) {
      groups.push(rest.slice(0, 4));
      rest = rest.slice(4);
    }
    if (rest) groups.push(rest);
  }
  return groups
    .map((g) => [...g].map((d) => PHONE_DIGITS[Number(d)]!).join(' '))
    .join(', ');
}

/** A time token with its optional attached prefix: "16:30", "מ-10:00", "ב-16:45", "בשעה 09:00". */
const TIME_RE = /(?:([בלמ])-?)?(\d{1,2}):([0-5]\d)(?![\d:])/gu;

/** "10:00-15:00" / "10:00–12:00" — a dashed range, spoken as "עשר עד שתים עשרה". */
const DASH_RANGE_RE = /(\d{1,2}:[0-5]\d)\s*[-–]\s*(\d{1,2}:[0-5]\d)/gu;

/** Price: a round amount directly before a currency word. */
const PRICE_RE = /(?<![\d,.])(\d{3,5})(?=\s*(?:שקל|שקלים|ש"ח|ש״ח|דולר))/gu;

/** A bare small integer before a following word (or clause end): "5 דקות", "3 ימים", "ב-4".
 * The lookbehind blocks digit-hyphen ("888-45" is a fragmented phone, not a count) but allows a
 * Hebrew prefix's hyphen ("ב-4" is how the model writes "at four"). */
const SMALL_INT_RE = /(?<![\d:,.])(?<!\d-)([בלמ]-)?(1[0-9]|[1-9])(?![\d:.])(\s+)?(\S+)?/gu;

/**
 * The whole normalizer. Deterministic, idempotent (its output contains no digits in the converted
 * spans, so a second pass is a no-op), and conservative: anything it does not positively
 * recognise is left exactly as written.
 */
export function normalizeSpokenNumbers(text: string): string {
  if (!/\d/u.test(text)) return text;

  let out = text;

  // 1. Phone numbers FIRST — the longest digit runs, so nothing else nibbles at them.
  out = out.replace(PHONE_RE, (m) => phoneToWords(m));

  // Context for the daypart heuristic, computed BEFORE any time is rewritten.
  const timeCount = [...out.matchAll(new RegExp(TIME_RE.source, 'gu'))].length;
  const isRangeContext =
    timeCount > 1 || RANGE_MARKERS.test(out) || DASH_RANGE_RE.test(out);
  DASH_RANGE_RE.lastIndex = 0;
  const hasDaypart = DAYPART_WORDS.test(out);

  // 2. Dashed ranges become "X עד Y" — before single times, so both ends convert together.
  out = out.replace(DASH_RANGE_RE, (_m, a: string, b: string) => {
    const [ah, am] = a.split(':').map(Number) as [number, number];
    const [bh, bm] = b.split(':').map(Number) as [number, number];
    if (ah > 23 || bh > 23) return _m;
    return `${timeToWords(ah, am)} עד ${timeToWords(bh, bm)}`;
  });

  // 3. Single clock times, with their prefixes ("מ-10:00" → "מעשר").
  out = out.replace(TIME_RE, (m, prefix: string | undefined, hh: string, mm: string) => {
    const h = Number(hh);
    if (h > 23) return m;
    let words = timeToWords(h, Number(mm));
    // Daypart only when genuinely confusable: a lone evening hour (18:00–21:59) in a sentence
    // that is not a range and names no daypart already. Business calls default to daytime, so
    // evening is the direction that misleads; when unsure, omit — context usually carries it.
    if (!isRangeContext && !hasDaypart && h >= 18 && h <= 21) words = `${words} בערב`;
    return `${prefix ?? ''}${words}`;
  });

  // 4. Prices — only the round shapes in PRICE_WORDS; anything else stays digits.
  out = out.replace(PRICE_RE, (m, amount: string) => PRICE_WORDS[Number(amount)] ?? m);

  // 5. Bare small integers 1–19: feminine counting form by default; masculine only before the
  //    curated noun list; dates (before a month name) are skipped outright.
  out = out.replace(
    SMALL_INT_RE,
    (
      m,
      prefix: string | undefined,
      num: string,
      gap: string | undefined,
      follower: string | undefined,
    ) => {
      const n = Number(num);
      const next = follower ?? '';
      const bare = next.replace(/[.,!?…׃"'״]+$/u, ''); // "ימים." must still read as ימים
      if (MONTHS.test(bare)) return m; // "ב-3 באוקטובר" is a date — untouched beats wrong.
      const word = MASCULINE_NOUNS.test(bare) ? MASC_UNITS[n]! : FEM_UNITS[n]!;
      // The prefix keeps its letter, drops its hyphen: "ב-4" → "בארבע".
      return `${prefix ? prefix[0] : ''}${word}${gap ?? ''}${next}`;
    },
  );

  return out;
}
