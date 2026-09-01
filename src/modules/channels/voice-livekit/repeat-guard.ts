import { leadingOpener, ledgerTokens } from './phrase-ledger.js';

/**
 * THE SENTENCE SHE HAS ALREADY SAID — and the RESTART the counters could not see.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-09-01 09:29, live PSTN, build ba01136). Seven seconds,
 * three replies, one sentence:
 *
 *     [205.0-205.3s] KEREN  "אוקי. זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה. אנחנו"
 *     [209.2-209.7s] KEREN  "זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה. אנחנו"
 *     [211.8-212.4s] KEREN  "זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה. לא,"
 *
 * and `summary.duplicateReplies` read **0**.
 *
 * ── WHAT ACTUALLY HAPPENED, established from the report rather than assumed ────────────────────
 *
 * Not one reply replayed by the audio path. THREE SEPARATE GENERATIONS: `llm_metrics` at 207149,
 * 209354 and 211136ms, each with its own `model_ttft` (778 / 767 / 775ms) and its own
 * `tts_metrics`. The caller interjected four times in nine seconds — "לשתף איתו פרטים.",
 * "ירצו לדבר ישירות עם בן אדם.", "זה לא יעשה לי עבודה כפולה?" — every one of them a facet of the
 * SAME objection, and gpt-5.4 answered each from the top with the same prompt-supplied empathy
 * opener. Each attempt was cut off by the next interjection after 0.27s / 0.45s / 0.56s of audio
 * (the SDK's own `startedSpeakingAt`/`stoppedSpeakingAt` on the committed messages).
 *
 * So the caller did not hear the sentence three times. He heard it BEGIN three times, which is the
 * same complaint with a different mechanism behind it: an interrupted turn is restarted from the
 * top instead of continued.
 *
 * ── WHY THE COUNTER STAYED GREEN, WHICH IS THE PART THAT MATTERS ──────────────────────────────
 *
 * `duplicateReplies` compared committed transcript lines with `===`. Those three lines are three
 * DIFFERENT strings: one carries the injected acknowledgement ("אוקי. "), and the truncation point
 * moved by one word between the second and the third. An exact-equality test is structurally blind
 * to a restarted turn, because a restart is never byte-identical — the interruption decides where
 * it stops, and the interruption lands somewhere new every time.
 *
 * That is the THIRD metric to stay green through the exact defect it exists to catch
 * (`repeatedPhraseCount` on 2026-08-29, `cutOffs` which has never counted anything on a vad-mode
 * call, and now this one). `isRestartOf` below is the repair: it compares on a normalised token
 * PREFIX, after removing the acknowledgement opener that is not the model's word at all.
 *
 * ── AND THE SECOND DEFECT ON THE SAME CALL, WHICH IS THE SAME SHAPE ───────────────────────────
 *
 *     [462s] KEREN  "קרה לי תקלה קטנה. אני אעביר את זה לצוות שלנו והם יחזרו אליךָ לתיאום מדויק."
 *     [468s] KEREN  "יש תקלה רגעית במערכת. אני אעביר את זה לצוות שלנו והם יחזרו אליךָ לתיאום מדויק."
 *
 * `book_meeting` failed three times in twenty seconds (root cause fixed separately, on main in
 * e08ba1b), and the prompt's single instruction — *"apologize briefly, say a natural variation of
 * «אעביר לצוות ונחזור אליך לתיאום מדויק»"* — was obeyed twice. Neither line is a fixed string in
 * this repo: both are the model's own paraphrases of one rule, and their SECOND HALVES are
 * word-for-word identical.
 *
 * One sentence said twice inside half a minute, and one sentence restarted after a barge-in, are
 * the same failure at two granularities. `SpokenSentenceLedger` handles the sentence; `isRestartOf`
 * measures the reply. Both live here so the next person finds them together.
 */

/** How many leading tokens two replies must share before a restart is even considered. */
export const MIN_RESTART_TOKENS = 5;

/**
 * How much of the SHORTER reply the shared prefix must cover.
 *
 * A restart is a reply that IS its predecessor, up to wherever the interruption fell. Two replies
 * that merely open alike — six shared words in front of twenty different ones — are a repeated
 * PHRASE, which `repeatedPhraseCount` already counts in its own currency and which this must not
 * double-count. 0.6 separates the two on every case in the 2026-09-01 report: the three empathy
 * restarts score 1.00, 0.92 and 1.00.
 */
export const MIN_RESTART_COVERAGE = 0.6;

/**
 * Comparison tokens for a whole reply: niqqud and punctuation dropped (`ledgerTokens`), and then
 * the leading ACKNOWLEDGEMENT removed if there is one.
 *
 * Removing the opener is not cosmetic. `llmNode` injects the acknowledgement ahead of the model's
 * first word, so "אוקי." at the head of a reply is OUR token, not the model's — and on the 09:29
 * call it is the single reason the first of the three restarts did not match the other two. A
 * comparison that keeps it is comparing our own injection, not her sentence.
 */
export function replyTokens(text: string): string[] {
  const tokens = ledgerTokens(text);
  const opener = leadingOpener(text);
  if (opener !== null && tokens[0] === opener) return tokens.slice(1);
  return tokens;
}

/** How many leading tokens two token lists share. */
function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit && a[n] === b[n]) n++;
  return n;
}

/**
 * Is `curr` a RESTART of `prev` — the same reply, begun again?
 *
 * Deliberately NOT "one is a prefix of the other". Both members of the 209/212 pair were cut off
 * mid-word, at different words, so neither is a prefix of the other: they share eleven tokens and
 * then diverge into "אנחנו" and "לא". Prefix equality would have missed two of the three, which is
 * how the old exact-match test failed in the first place — a rule that only fires on a clean
 * truncation cannot see a defect whose whole nature is that the truncation point moves.
 */
export function isRestartOf(prev: string, curr: string): boolean {
  const a = replyTokens(prev);
  const b = replyTokens(curr);
  if (a.length === 0 || b.length === 0) return false;
  const shared = commonPrefixLength(a, b);
  if (shared < MIN_RESTART_TOKENS) return false;
  return shared / Math.min(a.length, b.length) >= MIN_RESTART_COVERAGE;
}

/**
 * How long a sentence stays "already said".
 *
 * 30s covers both 2026-09-01 sequences with room to spare (the empathy restarts are 4.4s and 2.7s
 * apart, the two apologies 6.1s) and stays under the span in which a caller can legitimately make
 * her repeat something — asking for a phone number again three minutes later must still work. The
 * phrase ledger's own draft-echo window is 20s and this is the same order of magnitude on purpose.
 */
export const REPEAT_WINDOW_MS = 30_000;

/**
 * Below this many tokens a sentence is a REACTION, not a statement, and repeating it is normal
 * speech. "בסדר.", "כן.", "רגע, בודקת." must never be suppressed — the whole Speech Rhythm section
 * asks for exactly those, and a guard that deduped them would strip her acknowledgements.
 */
export const MIN_SUPPRESSIBLE_TOKENS = 4;

/** The caller asking to hear something again — the one case where a repeat is the correct answer. */
const ASKED_TO_REPEAT =
  /(?:תחזרי|תחזור|תגידי\s+שוב|תגיד\s+שוב|לא\s+שמעתי|מה\s+אמרת|עוד\s+פעם|שוב\s+בבקשה|סליחה\s*\?|חזרי)/u;

export function callerAskedToRepeat(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.length > 0 && ASKED_TO_REPEAT.test(text);
}

/**
 * WHAT SHE HAS ALREADY SENT TO THE TTS, sentence by sentence.
 *
 * Recorded at the point text is handed to Cartesia rather than when the message commits, because
 * that is the only place that sees a sentence which was interrupted before it finished — and an
 * interrupted sentence is precisely the one about to be said again.
 *
 * It holds what was FORWARDED, not what was HEARD. Those differ exactly when a barge-in cancels
 * playout, which is the case this exists for: suppressing the second attempt means the caller
 * never hears that sentence in full. That is the deliberate trade. On the 09:29 call the
 * alternative was hearing its first four words three times in seven seconds, and the substance of
 * the answer — which is behind it in the same reply — arriving twenty-nine seconds late.
 */
export class SpokenSentenceLedger {
  readonly #said: Array<{ key: string; at: number }> = [];
  readonly #windowMs: number;

  constructor(windowMs: number = REPEAT_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  /** Comparison form of one sentence: niqqud, punctuation and spacing are not part of "the same". */
  static key(sentence: string): string {
    return ledgerTokens(sentence).join(' ');
  }

  /** Is this sentence long enough to be worth suppressing at all? See MIN_SUPPRESSIBLE_TOKENS. */
  static suppressible(sentence: string): boolean {
    return ledgerTokens(sentence).length >= MIN_SUPPRESSIBLE_TOKENS;
  }

  /** One sentence on its way to the TTS. `at` is injectable for tests. */
  observe(sentence: string, at: number = Date.now()): void {
    const key = SpokenSentenceLedger.key(sentence);
    if (!key) return;
    this.#said.push({ key, at });
  }

  /** Has this exact sentence gone out inside the window? */
  wasSaidRecently(sentence: string, at: number = Date.now()): boolean {
    const key = SpokenSentenceLedger.key(sentence);
    if (!key) return false;
    return this.#said.some((s) => s.key === key && at - s.at <= this.#windowMs && at >= s.at);
  }

  /** For the log line and the tests. */
  get size(): number {
    return this.#said.length;
  }
}
