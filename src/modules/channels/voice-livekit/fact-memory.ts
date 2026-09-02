/**
 * WHAT SHE ALREADY KNOWS, AND WHAT SHE HAS ALREADY ASKED — the call's identity memory.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-08-29 18:30, live PSTN):
 *
 *     16490  KEREN  "אהה. קודם כל — איך קוראים לךָ?"
 *     28895  KEREN  "… רק שאדע עם מי אני מדברת?"
 *     42176  KEREN  "… איך קוראים לךָ?"
 *     47019  lead   "אם דיברנו על זה כבר, קרן, אני קורן"      <- "we already covered this"
 *     54149  KEREN  "אוקיי. נעים מאוד, קורן."
 *     103531 lead   "טל, אוזן"                                 <- STT garbage, not a name
 *     109172 KEREN  "נעים מאוד, טל."                           <- she renamed the lead
 *
 * Two failures, one cause: nothing in the pipeline held the difference between a fact we HAVE and
 * a fact we WANT. So the same question could be asked a third time, and a bare noun in a garbled
 * turn could overwrite a name the caller had stated plainly and she had acknowledged.
 *
 * ── Why code and not a prompt line ────────────────────────────────────────────────────────────
 *
 * The prompt already said "if he already gave it at the start, just confirm it". It said that
 * during the call above. Prompt instructions degrade under context load — the same lesson that
 * produced the phrase ledger (prompt = guidance, code = enforcement). This is the enforcement
 * half; the prompt half lives in system-prompt.he.ts under "Call Memory".
 *
 * ── The asymmetry, which is the whole design ──────────────────────────────────────────────────
 *
 * SETTING a fact is cheap: the model calls capture_lead_info and we believe it. REPLACING an
 * established identity is not, and must not be, the same act:
 *
 *   - An identity is spoken aloud, constantly, from the moment it is learned. A wrong one is
 *     heard by the caller within seconds and cannot be taken back.
 *   - A wrong budget or timeline is silent bookkeeping. It is corrected by the next tool call and
 *     nobody hears it. So qualification fields stay freely overwritable — "call it again whenever
 *     a fact changes" is the right rule THERE.
 *   - The DB already refused the rename (`upsertLead` coalesces and never blanks), so the tool
 *     accepting it produced the worst of both worlds: the CRM kept קורן while she called him טל.
 *
 * So: name / phone / email may be ENRICHED (קורן → קורן שטרית) but never REPLACED, unless the
 * model explicitly asserts the lead corrected it (`is_correction`). A bare noun in a noisy turn
 * is not an explicit correction, which is exactly the property we needed.
 */

// The project's ONE definition of "this sentence is a question" — the same predicate the
// one-question-per-reply rule enforces. Reused rather than re-derived so the ask counter and the
// speech guard can never disagree about what she asked.
import { isQuestionSentence } from './speech-guard.js';

/**
 * The facts worth remembering that we ask direct questions about.
 *
 * The first four are the original set. The last four are Koren's five mandatory discovery
 * questions minus `business`, which was already here — `process` (who answers his enquiries and how
 * fast), `frustration`, `closing` (phone / Zoom / in person) and `volume` (new enquiries per day).
 *
 * THEY WERE ADDED BECAUSE THEIR ABSENCE WAS MEASURED, not because the list looked short. On the
 * 2026-09-01 14:56 call she asked who answers his enquiries at 121s, 152s, 159s and 334s. Four
 * times, and the ask counter read ZERO for all four, because no such field existed. He said it out
 * loud on the next call, 15:33 at 183s: *"אנחנו לא מנהלים פה איזשהו דו-שיח, זה רק שאילת שאלות."*
 */
export type FactField =
  | 'name'
  | 'phone'
  | 'email'
  | 'business'
  | 'process'
  | 'frustration'
  | 'closing'
  | 'volume';

/**
 * Every field, in note order. The note used to iterate `Object.keys(ASK_PATTERNS)`, which silently
 * meant "only the fields with a literal phrasing table" — the exact reason four of the five
 * mandatory questions could be asked forever without the note ever mentioning them.
 */
export const FACT_FIELDS: readonly FactField[] = [
  'name',
  'phone',
  'email',
  'business',
  'process',
  'frustration',
  'closing',
  'volume',
];

/** The three that are the lead's IDENTITY — the ones that are hard to overwrite. */
export const IDENTITY_FIELDS = ['name', 'phone', 'email'] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** How many times she may ask for one fact before the note tells her to stop and move on. */
export const MAX_ASKS_PER_FACT = 2;

const NIQQUD = /[֑-ׇ]/gu;

/** Comparison form: niqqud, punctuation and case are not part of "is this the same name". */
function normalize(value: string): string {
  return value
    .replace(NIQQUD, '')
    .replace(/[.,!?…׃:;()"'«»״׳-]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

/**
 * Is `offered` the same identity as `established`, only fuller?
 *
 * "קורן" → "קורן שטרית" is a person giving his surname, not a different person, and refusing it
 * would make the guard block the very thing Step 4 asks her to collect ("full name"). Token
 * containment in EITHER direction counts: a model that shortens "קורן שטרית" to "קורן" has also
 * not renamed anybody.
 */
function isEnrichment(established: string, offered: string): boolean {
  const a = normalize(established).split(' ').filter(Boolean);
  const b = normalize(offered).split(' ').filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  const [shortSide, longSide] = a.length <= b.length ? [a, b] : [b, a];
  return shortSide.every((token) => longSide.includes(token));
}

/**
 * The Hebrew she actually says when she asks for each fact.
 *
 * Matched against her COMMITTED utterances, so this reads what was really spoken rather than
 * trying to predict what the model intends to say. Every pattern below is lifted from the
 * prompt's own example phrasings (Step 2's name bank, Step 4's collection script) plus the three
 * variants she improvised on the 2026-08-29 call — which is the point: the bank is examples, she
 * varies them, and a detector built only from the bank would have missed two of her three asks.
 *
 * Deliberately UNDER-inclusive on `business`: "מה אתה מוכר" is also how she asks a follow-up about
 * a product she already knows about, and a false "you already asked this" is worse than a missed
 * one — it would silence a legitimate question.
 *
 * That reasoning still stands, and ASK_INTENTS below does not delete it — it narrows the SCOPE the
 * risk applies to (question sentences only) instead of widening the phrasings blindly.
 *
 * Only the four original fields have a literal table. The four discovery fields are matched by
 * intent alone, which is what makes `VOICE_ASK_INTENT_ENABLED=false` restore the pre-2026-09-02
 * behaviour byte for byte: with the intent layer off, those fields can never reach a count.
 */
const ASK_PATTERNS: Partial<Record<FactField, RegExp[]>> = {
  name: [
    /איך\s+קוראים\s+ל/u,
    /מה\s+ה?שם(\s+המלא)?/u,
    /מה\s+שמ(ך|ךָ|ך\?)/u,
    /עם\s+מי\s+אני\s+מדבר(ת)?/u,
    /לא\s+תפסתי\s+את\s+ה?שם/u,
    // No longer a phrasing the prompt offers — "No Preamble" (2026-08-31) removed every "רק שאדע"
    // variant. Kept as a DETECTOR, not a suggestion: if the model reaches for it anyway, this still
    // has to count the ask, and the cost of an unused pattern is nothing.
    /רק\s+שאדע.{0,20}(שם|מי)/u,
    /אפשר\s+לדעת\s+עם\s+מי/u,
  ],
  phone: [/מספר\s+ה?טלפון/u, /מה\s+ה?טלפון/u, /מספר\s+ל?חזור/u],
  email: [/כתובת\s+ה?מייל/u, /מה\s+ה?מייל/u, /ה?אימייל/u],
  business: [/איזה\s+(סוג\s+)?עסק/u, /במה\s+אתה\s+עוסק/u, /מה\s+ה?עסק\s+של(ך|ךָ)/u],
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * COUNTING BY INTENT — the half that was missing, and the trade-off it is built on.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE MEASUREMENT (2026-09-01 14:56, `call-reports/2026-09-01T11-56-17-832Z.json`, replayed):
 *
 *    40s  KEREN  "במה אתה עוסק?"                                            <- ASK_PATTERNS hit
 *    74s  KEREN  "אֶממ... מה אתה עושה ביוםיום?"                              <- MISSED
 *    85s  KEREN  "אמ. במה אתה עוסק?"                                        <- ASK_PATTERNS hit
 *   111s  KEREN  "אני שואלת על העבודה שלךָ. מה אתה עושה ביוםיום?"            <- MISSED
 *   317s  KEREN  "…מה העסק שלךָ עושה בפועל?"                                <- ASK_PATTERNS hit
 *   321s  lead   "אנחנו סוכנות לבניית אתרים."
 *   323s  lead   "שאלת את זה כבר, לא?"                                       <- he counted five
 *
 * Five asks, three counted. The two misses are the same question in words the phrasing bank never
 * offered, which is the structural flaw: ASK_PATTERNS is a list of phrasings, and she improvises.
 *
 * ── The trade-off I chose, and why ────────────────────────────────────────────────────────────
 *
 * A false "you already asked this" silences a legitimate question, and that is still the expensive
 * direction. So instead of widening the phrasing list — which widens the risk everywhere — the
 * intent layer narrows WHERE it may fire and requires MORE evidence when it does:
 *
 *   1. QUESTION SENTENCES ONLY. A field is matched against the sentences of her turn that end in a
 *      question mark (`isQuestionSentence`, the project's one definition of a question, the same
 *      one the one-question-per-reply rule uses). This alone kills a whole class of false
 *      positives for free: at 392s she said *"אז היום גם אתה וגם מישהו מהצוות מטפלים בזה. מה הכי
 *      היית רוצֶה לשפר שם?"* — the statement summarising his answer mentions מטפלים and would have
 *      matched `process`; only the question half is looked at, and that half asks about frustration.
 *
 *   2. CO-OCCURRENCE, NOT KEYWORDS. Every regex in `requires` must match the SAME question
 *      sentence. `process` needs an interrogative (מי / איך) AND a responder verb (עונה / מטפל /
 *      חוזר / תופס) AND a target (פנייה / ליד / לקוח / שיחה). One word out of three is not an ask.
 *      This is what keeps "איך זה נשמע לךָ?" and "כמה זמן ביום זה לוקח לךָ?" out.
 *
 *   3. DEEPENING IS NOT RE-ASKING — the distinction Koren cares about most. Once the LEAD has
 *      actually answered a field, later questions on that topic are not counted at all. Two real
 *      lines from the same call, nine and forty-eight seconds after he answered:
 *
 *        339s  lead   "אה... אנחנו בדרך כלל עונים."          <- the answer
 *        343s  KEREN  "וכמה מהר אתם חוזרים בדרך כלל?"        <- builds on it. NOT a re-ask.
 *        382s  KEREN  "…מי תופס את השיחות והפניות שנכנסות — אתה, או מישהו מהצוות?"   <- also not
 *
 *      382s matches `process` on every one of its three groups; it is excluded by the answer, not
 *      by a lexical dodge. That is deliberate — tuning the verb list until 382s fell out would have
 *      been fitting the regex to one transcript.
 *
 * ── What this DELIBERATELY still misses ───────────────────────────────────────────────────────
 *
 * An improvisation that shares no keyword with its field at all is not counted, and a question she
 * asks without a question mark is not counted. Both are the under-inclusive side of the same
 * choice, and both are cheaper than one wrongly-suppressed question.
 */
interface AskIntent {
  /** ALL of these must match the same question sentence. */
  requires: RegExp[];
  /**
   * Words that make even a very short lead reply a complete answer.
   *
   * A closed question deserves a closed answer: "בזום." is three characters and settles `closing`
   * completely, where the word-count rule below would read it as noise. Only for fields whose
   * answer space is genuinely small — a menu, or a number.
   */
  answerTokens?: RegExp;
}

const ASK_INTENTS: Partial<Record<FactField, AskIntent>> = {
  // "במה אתה עוסק" / "מה אתה עושה ביום-יום" / "מה העסק שלךָ עושה בפועל".
  // `אתה עושה` and not a bare `עושה`: at 178s of the 15:33 call she said "מה אתם עושים?" — about
  // OUR company, prompted by him, and counting it as an ask about HIS business would be exactly the
  // false positive this whole file is careful about.
  business: {
    requires: [
      /(?:^|[\s—–-])ו?(?:במה|מה|איזה|באיזה)(?![א-ת])/u,
      /(?:עוסק|עוסקת|עסק|תחום|אתה\s+עושה|העבודה\s+של(?:ך|ךָ))/u,
    ],
  },
  // Who answers the enquiries, and how fast.
  process: {
    requires: [
      /(?:^|[\s—–-])ו?(?:מי|איך)(?![א-ת])/u,
      /(?:עונה|עונים|עונות|מטפל|מטפלת|מטפלים|מענה|חוזר|חוזרים|תופס|תופסת)/u,
      /(?:פני(?:ה|יה|ות|יות)|לידים|ליד(?![א-ת])|לקוח|לקוחות|שיחות)/u,
    ],
  },
  // What frustrates him. Deliberately keyed on the FEELING word, not on "מה" — she opens half her
  // discovery questions with "מה".
  frustration: {
    requires: [
      /(?:^|[\s—–-])ו?(?:מה|איזה|כמה)(?![א-ת])/u,
      /(?:מתסכל|מסתבך|מציק|שוחק|מפריע|כואב|מעצבן|לשפר|מתקן|הכי\s+קשה)/u,
    ],
  },
  // How he closes: phone, Zoom, in person.
  closing: {
    requires: [
      /(?:^|[\s—–-])ו?(?:איך|מה|במה|באיזה)(?![א-ת])|בדרך\s+כלל/u,
      /(?:סוגר|סוגרים|סוגרת|סגירה|נסגר|נסגרות)/u,
    ],
    answerTokens: /(?:בטלפון|טלפון|בזום|זום|בפגישה|פגישה|פרונטלי|פנים\s+אל\s+פנים|וידאו)/u,
  },
  // How many new enquiries a day. The period group is what separates it from "כמה מהפניות האלה
  // נשארות בלי מענה?" (156s, 15:33 call), which is a different question about the same noun.
  volume: {
    requires: [
      /(?:^|[\s—–-])ו?כמה(?![א-ת])/u,
      /(?:פני(?:ה|יה|ות|יות)|לידים|ליד(?![א-ת]))/u,
      /(?:ביום|ליום|ב?שבוע|ב?חודש|יומי|ביומיים)/u,
    ],
    answerTokens: /\d/u,
  },
};

/**
 * How many content words a lead turn needs before it counts as an ANSWER rather than noise.
 *
 * ⚠️ THE WEAKEST NUMBER IN THIS FILE, and it is load-bearing: it is what decides whether a later
 * question is a re-ask or a follow-up. Calibrated against the two 2026-09-01 calls:
 *
 *     "יש לי עסק."                   3 words  -> NOT an answer
 *     "אה... אנחנו בדרך כלל עונים."   4 words  -> an answer
 *
 * The first is not my judgement — it is HERS. At 334s, twenty minutes after he said it, she said
 * *"שאלתי מוקדם יותר ולא קיבלתי תשובה ברורה"*, and the model's own `capture_lead_info` recorded
 * `business_type: "יש לו עסק"`, which is the shape of a business, not a business. A three-word
 * clause that names the category the question already named answers nothing.
 *
 * Four words is nevertheless four words, and a genuinely terse caller ("אני עורך דין") will be read
 * as not having answered — the cost of that is one extra ask being counted, which pushes the note
 * to fire EARLIER. `answerTokens` exists so the closed questions do not pay that cost at all.
 */
export const MIN_ANSWER_WORDS = 4;

/**
 * Sounds, not words. Stripped before counting, so a hesitation does not pad a non-answer into an
 * answer. Deliberately does NOT include כן / לא: those are answers to a yes/no question, and a
 * one-word turn is below the threshold anyway.
 */
const HESITATION = /^(?:אה+|אמ+|המ+|אוקיי?|אהה+|מממ+|אֶה+|אֶמ+)$/u;

/**
 * He is asking BACK, not answering. Any of these in his turn and the question stays open.
 *
 * Every one of them is a real line from the two calls: "מה השאלה? לא הבנתי." (82s), "כן, לא הבנתי
 * מה את שואלת." (106s), "מה אמרת? לא הבנתי." (42s of the 15:33 call). A turn like this is the
 * strongest possible evidence that the question did NOT land — reading it as an answer would
 * suppress the very re-ask that is legitimate.
 */
const NOT_AN_ANSWER = /(?:לא\s+הבנתי|לא\s+הבנת|לא\s+שמעתי|מה\s+אמרת|מה\s+השאלה|לא\s+ברור\s+לי)/u;

/** Splits a turn into sentences, keeping the terminator so `isQuestionSentence` can read it. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…׃])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Did the lead's turn ANSWER the question she just asked?
 *
 * Three ways to be a non-answer, in order of how strong the evidence is:
 *   - he asked back (the turn ends in a question mark) — "למה אני. עוסק?" at 88s;
 *   - he said he did not understand — see NOT_AN_ANSWER;
 *   - he said too little to have said anything — see MIN_ANSWER_WORDS.
 *
 * Not field-aware beyond `answerTokens`, and deliberately so: deciding whether a specific sentence
 * answers a specific question is a model's job, not a regex's, and getting it wrong in the
 * permissive direction would silence a legitimate re-ask.
 */
function isAnswer(text: string, intent: AskIntent | undefined): boolean {
  if (isQuestionSentence(text)) return false;
  if (NOT_AN_ANSWER.test(text)) return false;
  if (intent?.answerTokens?.test(text)) return true;
  const words = normalize(text)
    .split(' ')
    .filter((w) => w.length > 0 && !HESITATION.test(w));
  return words.length >= MIN_ANSWER_WORDS;
}

/**
 * "Pleased to meet you" — and the fact that it is a ONE-TIME move.
 *
 * Koren, on the 2026-08-30 call: *"הסוכן גם אומר נעים מאוד באמצע השיחה, זה מיותר ומוזר, זה משהו
 * שאומרים רק בתחילת השיחה"*. She said it correctly at 35s, right after he introduced himself, and
 * again at 164s — triggered by nothing but a surname landing in `capture_lead_info`:
 *
 *     153.7s  KEREN  "רק לוודֵא — קורן, נכון? ומה שם המשפחה שלךָ?"
 *     156.5s  lead   "שטרית."
 *     163.8s  KEREN  "אהה. נעים מאוד. רק לוודֵא — קורן שטרית, נכון?"
 *
 * Greeting a man you have been talking to for three minutes is the same class of defect as asking
 * his name three times: it says she has no idea where she is in the conversation. So it belongs
 * here, in the state that already knows what has happened on this call, rather than in a new one.
 *
 * The latch is set from her COMMITTED utterances, for the same reason the ask counter is: what
 * matters is whether the caller has already HEARD it, not whether the model meant to say it.
 */
const INTRODUCED = /נעים\s+(?:מאוד|מאד|להכיר)/u;

/** English labels for the note — the note is read by the model, whose instructions are English. */
const FIELD_LABEL: Record<FactField, string> = {
  name: "the lead's name",
  phone: 'his phone number',
  email: 'his email address',
  business: 'what his business is',
  process: 'who answers his enquiries today and how fast',
  frustration: 'what frustrates him most about that',
  closing: 'how he closes a customer (phone / Zoom / in person)',
  volume: 'how many new enquiries he gets a day',
};

export interface CaptureVerdict {
  /** The identity values that may be written, after the guard. */
  accepted: { name?: string; email?: string; phone?: string };
  /** Values refused because they would have REPLACED an established identity. */
  refused: Array<{ field: IdentityField; kept: string; offered: string }>;
  /**
   * Values refused because the LEAD HIMSELF said they were wrong — a different refusal, and a
   * stronger one. `refused` above protects a value we hold; this protects the caller from hearing
   * back the exact string he has just contradicted. See `reject()`.
   */
  rejected: Array<{ field: IdentityField; offered: string }>;
}

export interface FactMemoryOptions {
  /**
   * Count asks by INTENT as well as by literal phrasing, and remember the four discovery fields.
   * Kill-switch: `VOICE_ASK_INTENT_ENABLED` (agent.ts owns the read; this class stays env-free so
   * it can be replayed against a transcript in a test).
   *
   * `false` restores the pre-2026-09-02 behaviour exactly: only ASK_PATTERNS counts, only the four
   * original fields can ever reach a count, and no lead turn is ever read as an answer.
   */
  intentAsks?: boolean;
}

export class FactMemory {
  readonly #known = new Map<FactField, string>();
  readonly #asks = new Map<FactField, number>();
  readonly #intentAsks: boolean;
  /**
   * Fields the LEAD has actually answered — the "deepening is not re-asking" state.
   *
   * Separate from `#known`, and it must stay separate. `#known` is what `capture_lead_info` chose
   * to save, and on the 14:56 call the model did not call that tool ONCE in the first four minutes
   * — every business ask in the transcript happened while `#known` was empty. This set is read off
   * the caller's own turns, so it is true the moment he speaks rather than whenever the model gets
   * round to recording it.
   */
  readonly #answered = new Set<FactField>();
  /** Fields asked in her last question turn, waiting to see whether his next turn answers them. */
  #pending = new Set<FactField>();

  constructor(options: FactMemoryOptions = {}) {
    this.#intentAsks = options.intentAsks ?? true;
  }
  /**
   * WHAT THE LEAD HAS SAID IS WRONG — the other half of "is this fact settled?", and the half that
   * was missing on 2026-08-31.
   *
   * She read `k o r e n at gmail dot com` back to a man whose address starts `kas`, he said
   * "לא נכון", and eight seconds later she read the SAME value back again. Nothing held the
   * refusal: `#known` only ever grows, so a value the caller had explicitly killed was, to every
   * later turn, simply a value nobody had established yet. It cost the booking.
   *
   * A rejection is stronger than an establishment. It survives `is_correction` — that flag exists
   * to let the LEAD change a value, and the lead is precisely who ruled this one out.
   */
  readonly #rejected = new Map<IdentityField, string[]>();
  /** Committed utterances already counted, so the preemptive-draft echo cannot double-count an
   * ask. Same 20s rule and the same reason as PhraseLedger.observe / CallReport.recordTranscript. */
  #seen: Array<{ text: string; at: number }> = [];
  #introduced = false;

  /** Has she already said "נעים מאוד" out loud on this call? See INTRODUCED. */
  get introduced(): boolean {
    return this.#introduced;
  }

  /** What we hold for a field, or null. */
  get(field: FactField): string | null {
    return this.#known.get(field) ?? null;
  }

  /** How many times she has asked for it on this call. */
  asks(field: FactField): number {
    return this.#asks.get(field) ?? 0;
  }

  /** Everything established so far — for the note, and for tests. */
  snapshot(): Partial<Record<FactField, string>> {
    return Object.fromEntries(this.#known) as Partial<Record<FactField, string>>;
  }

  /**
   * The lead said this value is WRONG. It may never be saved or spoken again on this call.
   *
   * Fed by `email-dictation.ts`, which is what notices a read-back being contradicted. Kept here
   * rather than there because this is where "what may overwrite what" already lives, and because
   * `capture_lead_info` already reads this object — the enforcement point needs no new plumbing.
   *
   * Rejecting the value we currently HOLD also clears it: continuing to speak a value the caller
   * has just denied is the defect, and holding it would do exactly that.
   */
  reject(field: IdentityField, value: string | null | undefined): void {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return;
    const list = this.#rejected.get(field) ?? [];
    if (!list.some((v) => normalize(v) === normalize(trimmed))) list.push(trimmed);
    this.#rejected.set(field, list);
    const held = this.#known.get(field);
    if (held && normalize(held) === normalize(trimmed)) this.#known.delete(field);
  }

  /** Everything the lead has ruled out for a field. */
  rejectedValues(field: IdentityField): readonly string[] {
    return this.#rejected.get(field) ?? [];
  }

  /** Records a fact as established. Blank values never erase what we hold (coalesce, don't blank). */
  establish(field: FactField, value: string | null | undefined): void {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return;
    this.#known.set(field, trimmed);
  }

  /** Has the LEAD answered this field on this call? See `#answered`. */
  answered(field: FactField): boolean {
    return this.#answered.has(field);
  }

  /** Everything he has answered — for the note, and for tests. */
  answeredFields(): FactField[] {
    return FACT_FIELDS.filter((f) => this.#answered.has(f));
  }

  /**
   * One committed agent utterance — counts the questions inside it.
   *
   * At most ONE ask per field per utterance: "רק שאדע, איך קוראים לך?" matches two name patterns
   * and is still one question, and a field that the literal table AND the intent layer both match
   * is still one question.
   */
  observeAgentUtterance(text: string, at: number = Date.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.#seen.some((s) => s.text === trimmed && at - s.at < 20_000)) return;
    this.#seen.push({ text: trimmed, at });

    const asked = new Set<FactField>();
    for (const [field, patterns] of Object.entries(ASK_PATTERNS) as Array<[FactField, RegExp[]]>) {
      if (patterns.some((p) => p.test(trimmed))) asked.add(field);
    }
    if (this.#intentAsks) {
      // ONLY the question sentences. See the ASK_INTENTS header, point 1 — this is the scoping
      // that lets the keyword sets be broad without the risk being broad.
      const questions = sentences(trimmed).filter((s) => isQuestionSentence(s));
      for (const question of questions) {
        for (const [field, intent] of Object.entries(ASK_INTENTS) as Array<[FactField, AskIntent]>) {
          if (intent.requires.every((r) => r.test(question))) asked.add(field);
        }
      }
      // A question CLOSES the previous window. She has moved on to something else, so whatever he
      // says next is an answer to the new question, not a late answer to the old one. Without this,
      // his 203s answer about frustration would have been credited to the process ask at 159s and
      // the fourth process ask at 334s would have gone uncounted.
      if (questions.length > 0) this.#pending = new Set(asked);
      else for (const field of asked) this.#pending.add(field);
    }

    for (const field of asked) {
      // Already answered = this is a follow-up that builds on his answer, which is the behaviour
      // we want more of. Not a re-ask, so it does not push him towards the exhaustion note.
      if (this.#intentAsks && this.#answered.has(field)) continue;
      this.#asks.set(field, this.asks(field) + 1);
    }

    if (INTRODUCED.test(trimmed)) this.#introduced = true;
  }

  /**
   * One committed CALLER turn — decides whether the question she just asked actually landed.
   *
   * No-op when the intent layer is off, which is what keeps the switch a true revert.
   */
  observeCallerUtterance(text: string): void {
    if (!this.#intentAsks) return;
    const trimmed = text.trim();
    if (!trimmed || this.#pending.size === 0) return;
    for (const field of this.#pending) {
      if (!isAnswer(trimmed, ASK_INTENTS[field])) continue;
      this.#answered.add(field);
      this.#pending.delete(field);
    }
    // A turn that did NOT answer leaves the window OPEN, and that is deliberate. Soniox shreds one
    // spoken answer into several committed items — on the 14:56 call his answer to "how many
    // enquiries a day" arrived as "אה... נכנסות בין." and then, six seconds later, "15 ל-20 פניות.
    // 25 אפילו לפעמים." Closing the window on the first fragment would have thrown away the answer
    // and left `volume` looking unanswered for the rest of the call. The window is closed by HER
    // next question instead (observeAgentUtterance), which is the moment the old question really
    // has stopped being the one on the table.
  }

  /**
   * May capture_lead_info write these identity values?
   *
   * Enrichment yes, replacement no — see the header. `isCorrection` is the model asserting that
   * the LEAD corrected the value out loud; only that unlocks a replacement, and it also
   * re-establishes the new value so a second garbled turn cannot walk it back again.
   */
  guardIdentity(
    offered: { name?: string | null; email?: string | null; phone?: string | null },
    isCorrection: boolean,
  ): CaptureVerdict {
    const accepted: CaptureVerdict['accepted'] = {};
    const refused: CaptureVerdict['refused'] = [];
    const rejected: CaptureVerdict['rejected'] = [];

    for (const field of IDENTITY_FIELDS) {
      const raw = offered[field];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;

      // CHECKED BEFORE EVERYTHING ELSE, including `isCorrection`. That flag means "the lead
      // corrected this", and a value the lead has already denied out loud cannot be his correction
      // of itself. Saving it would put the wrong address in the CRM and — worse — licence her to
      // say it back to him a third time.
      if (this.rejectedValues(field).some((v) => normalize(v) === normalize(value))) {
        rejected.push({ field, offered: value });
        continue;
      }

      const held = this.#known.get(field);
      if (!held || normalize(held) === normalize(value) || isEnrichment(held, value) || isCorrection) {
        accepted[field] = value;
        this.establish(field, value);
        continue;
      }
      refused.push({ field, kept: held, offered: value });
    }

    return { accepted, refused, rejected };
  }

  /**
   * The turn-boundary reminder, or null when there is nothing worth spending tokens on.
   *
   * Two jobs, one note: stop asking for what you have, and stop asking for what he will not give.
   * It is APPENDED at the tail like the phrase note, never folded into the instructions — the
   * prompt-cache prefix must not move (see injectCoachNote in agent.ts).
   */
  note(): string | null {
    const known = [...this.#known.entries()].map(
      ([field, value]) => `${FIELD_LABEL[field]} = «${value}»`,
    );
    // FACT_FIELDS, not `Object.keys(ASK_PATTERNS)` — the old expression quietly meant "the fields
    // that happen to have a literal phrasing table", which is why four asks of the same discovery
    // question could never reach this list. `!answered` is the new exclusion and it only ever
    // REMOVES fields from the note: a question he has answered is not one she is stuck on.
    const exhausted = FACT_FIELDS.filter(
      (field) =>
        !this.#known.has(field) && !this.#answered.has(field) && this.asks(field) >= MAX_ASKS_PER_FACT,
    );
    const answered = this.answeredFields().filter((f) => !this.#known.has(f));
    const ruledOut = [...this.#rejected.entries()]
      .filter(([, values]) => values.length > 0)
      .map(([field, values]) => `${FIELD_LABEL[field]}: ${values.map((v) => `«${v}»`).join(', ')}`);
    if (
      known.length === 0 &&
      exhausted.length === 0 &&
      ruledOut.length === 0 &&
      answered.length === 0 &&
      !this.#introduced
    ) {
      return null;
    }

    const parts = ['[Call memory — automatic reminder]'];
    if (this.#introduced) {
      parts.push(
        'You have ALREADY greeted this lead ("נעים מאוד") earlier in this call. Greeting him ' +
          'again — because a surname or a phone number just arrived, or for any other reason — ' +
          'sounds like you have forgotten where you are. Acknowledge new details without ' +
          'reintroducing yourself.',
      );
    }
    if (known.length > 0) {
      parts.push(
        `Already established on this call: ${known.join('; ')}. Do NOT ask for any of these ` +
          'again — you already have them, use them. Treat an established name as settled: only ' +
          'change it if the lead explicitly corrects you out loud.',
      );
    }
    if (answered.length > 0) {
      // The line Koren's distinction turns on. He does not object to a second question about a
      // topic — he objects to the SAME question. "אנחנו לא מנהלים פה איזשהו דו-שיח, זה רק שאילת
      // שאלות" (15:33 call, 183s) is what it sounds like when she asks instead of listening.
      //
      // Note what this does NOT say: it never tells her to stop asking, and it never says she has
      // enough. Both readings ended a call on 2026-08-31 — see the exhaustion note below.
      parts.push(
        `He has ALREADY answered: ${answered.map((f) => FIELD_LABEL[f]).join(', ')}. Use his own ` +
          'answer — go deeper on what he actually said, and never put the same opening question ' +
          'to him a second time.',
      );
    }
    if (ruledOut.length > 0) {
      parts.push(
        `The lead has told you these values are WRONG — ${ruledOut.join('; ')}. Never say one of ` +
          'them back to him and never save it. He has already corrected you once on each; saying ' +
          'it again is what makes him repeat himself until the call runs out.',
      );
    }
    if (exhausted.length > 0) {
      // ⚠️ "Continue without it" USED TO END HERE, AND IT ENDED A CALL.
      //
      // 2026-08-31 16:51, replayed through this class from the real transcript: her phone asks at
      // 294s and 300s and her email asks at 320s and 331s each match ASK_PATTERNS twice, neither
      // field was in `#known`, so by 331s this note read *"You have already asked 2+ times for: his
      // phone number, his email address. Do not ask again … Continue without it."* Sixteen seconds
      // later she said "יש לי מספיק כדי להעביר לצוות" and called `end_call`, on a lead who had
      // agreed to 11:00 the next morning and for whom `book_meeting` had never run.
      //
      // The counter was not wrong — she really had asked twice, and a third ask is really the
      // moment he decides he is talking to a machine. What was wrong is that "continue without it"
      // has two readings and this note only meant one of them. It now says which.
      //
      // NOT CHANGED, deliberately: MAX_ASKS_PER_FACT, and the counting rule. Two asks six seconds
      // apart with only "טריט." between them is arguably one ask repeated — but every discriminator
      // I could write for that (a time cooldown, "did the caller speak in between") also collapses
      // the 2026-08-29 asks at 16.5s / 28.9s / 42.2s into one, which is the exact defect this class
      // was built for. So the counter stands and the WORDING carries the fix.
      parts.push(
        `You have already asked ${MAX_ASKS_PER_FACT}+ times for: ` +
          `${exhausted.map((f) => FIELD_LABEL[f]).join(', ')}. Do not ask again — asking a third ` +
          'time is the moment a caller decides he is talking to a machine. Continue the CALL ' +
          'without it: keep selling, keep booking, and use what he has already given you. This is ' +
          'not a reason to end the call, to stop trying to book the demo, or to tell him you have ' +
          'enough — whether you have enough to book is decided by the booking-state reminder and ' +
          'by the tool, never by this one.',
      );
    }
    return parts.join(' ');
  }
}
