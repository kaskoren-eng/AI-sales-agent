/**
 * The Hebrew STT test corpus.
 *
 * Ten utterances that a ClickScales caller would plausibly say, chosen so that the A/B measures the
 * things that have ACTUALLY broken on real calls, not a generic accuracy score:
 *
 *   - Short confirmations ("כן", "בסדר"). One-word utterances are where streaming STT garbles most
 *     — there is almost no acoustic context to disambiguate from — and a booking agent that
 *     mishears "כן" as "לא" is worse than no agent.
 *   - The name קורן. A real call transcribed it as "קורנטיטרי" (phase-4-known-issues §6). It is the
 *     founder's name and the single most-spoken proper noun on any of our calls.
 *   - A phone number and an email. Phase 4 CANNOT BOOK without them, and both were measured wrong
 *     on gpt-realtime-whisper: "05 0255 784" for the phone, "המל … קליקס כ-.קום" for the email.
 *
 * Both engines get biasing terms from VOICE_STT_PROMPT (Soniox via `context.terms`), so the name
 * and brand tests are a fair fight — this measures whether biasing WORKS, not whether one engine
 * was handed a hint the other wasn't.
 */

export type Category = 'greeting' | 'confirmation' | 'business';

export interface CorpusItem {
  /** Stable filename stem — also the key in reference-transcript.json. */
  id: string;
  category: Category;
  /** Ground truth. This exact string is what we hand Cartesia, so it is true by construction. */
  text: string;
  /** Why this line is in the corpus — kept so nobody "tidies up" a case that is load-bearing. */
  rationale: string;
}

export const CORPUS: CorpusItem[] = [
  // --- Greetings: the first thing the STT ever hears, with zero prior context to lean on. ---
  {
    id: 'greeting-01',
    category: 'greeting',
    text: 'שלום, מדבר יובל',
    rationale: 'Standard Hebrew phone opening. "מדבר" (speaking) is a telephony idiom.',
  },
  {
    id: 'greeting-02',
    category: 'greeting',
    text: 'היי, זה יובל מדבר',
    rationale: 'Casual register. Word order differs from greeting-01 on the same content.',
  },
  {
    id: 'greeting-03',
    category: 'greeting',
    text: 'אהלן, שמי יובל',
    rationale: 'אהלן is an Arabic loanword in everyday Hebrew — a plausible miss for a model that '
      + 'language-identifies per token.',
  },

  // --- Confirmations: one to three words. The hardest case, and the one that decides bookings. ---
  {
    id: 'confirm-01',
    category: 'confirmation',
    text: 'כן',
    rationale: 'ONE SYLLABLE. Almost no acoustic context. Mishearing yes/no breaks the booking.',
  },
  {
    id: 'confirm-02',
    category: 'confirmation',
    text: 'בסדר',
    rationale: 'Two syllables, soft consonants — first casualty of 8kHz narrowband.',
  },
  {
    id: 'confirm-03',
    category: 'confirmation',
    text: 'אוקיי מחר בשלוש',
    rationale: 'An English loanword next to a spoken TIME. Phase 4 books from exactly this.',
  },

  // --- Business answers: full sentences, and the two fields Phase 4 cannot book without. ---
  {
    id: 'business-01',
    category: 'business',
    text: 'יש לי חנות אונליין שמוכרת מוצרי טיפוח',
    rationale: 'Typical lead answer. "אונליין" is a transliterated English word mid-Hebrew.',
  },
  {
    id: 'business-02',
    category: 'business',
    text: 'אני מוציא בערך עשרים אלף בחודש על שיווק',
    rationale: 'Budget answer with a spoken number — drives lead qualification and scoring.',
  },
  {
    id: 'business-03',
    category: 'business',
    text: 'קוראים לי קורן ואני מנהל את קליקסקיילס',
    rationale: 'THE REGRESSION CASE. A live call turned "קורן" into "קורנטיטרי". Both the founder '
      + 'name and the brand are in the biasing terms, so this is the direct test of whether '
      + 'biasing does anything.',
  },
  {
    id: 'business-04',
    category: 'business',
    text: 'המספר שלי הוא אפס חמש שתיים, שלוש ארבע חמש, שש שבע שמונה תשע',
    rationale: 'A phone number spoken as WORDS, which is how people say them aloud. '
      + 'gpt-realtime-whisper returned "05 0255 784" — wrong digits, wrong grouping. Phase 4 '
      + 'cannot call a lead back on a number the STT invented.',
  },
];

/** The reference transcript, keyed by id — written to disk so the harness never re-derives it. */
export function referenceTranscript(): Record<string, { text: string; category: Category }> {
  return Object.fromEntries(
    CORPUS.map((item) => [item.id, { text: item.text, category: item.category }]),
  );
}
