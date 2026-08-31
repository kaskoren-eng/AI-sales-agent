/**
 * HOW MUCH IS THE CALLER ACTUALLY GIVING YOU — and what she is allowed to do with it.
 *
 * Two questions, one file, because they are the same measurement read at two ranges.
 *
 * ── The turn-sized question: did he just SHARE something? ─────────────────────────────────────
 *
 * Koren, 2026-08-31, after a ten-minute production call: *"הסוכן אמר 'טוב, הבנתי' או 'הבנתי אותך'
 * יותר מדי פעמים, וצריך באמת להגיע בהקשר כשהלקוח משתף מידע שרלוונטי לשיחה. לא סתם להגיד 'טוב,
 * הבנתי' על כל דבר."*
 *
 * `טוב, הבנתי.` and `הבנתי אותך.` are not written by the model — they are two of the five words in
 * ACKNOWLEDGEMENTS_HE_WIDE, which the agent speaks at the head of EVERY turn before the model has
 * written anything. On that call the deck spoke one of them roughly every other turn, including
 * after "מחר.", after "כן.", and after a question. `repeatedPhraseCount` was 34.
 *
 * The other three members ("אוקיי.", "אהה.", "בסדר.") are pure receipts: they mean *I heard you*
 * and are true after anything. These two are COMPREHENSION CLAIMS — they mean *I have taken in what
 * you told me* — and after a one-word answer that claim is empty, which is exactly what a listener
 * hears as a machine. So they stop being deck members and become EARNED: available only on a turn
 * where the caller genuinely told her something.
 *
 * ── The call-sized question: how deep may she dig? ────────────────────────────────────────────
 *
 * Koren, same session: *"אם הלקוח קצר מדי בשיחה ולא משתף פעולה, הסוכן צריך להבין שהוא לא הולך
 * לשאול הרבה שאלות, אלא רק מה שחשוב. להפך, אם הלקוח משתף, הסוכן יכול לשאול עוד טיפה שאלות."*
 *
 * The prompt half is the mandatory/optional split in the discovery bank. This is the half that
 * tells her which kind of caller she has, because a model reading its own transcript is a bad judge
 * of that and drifts under context load (the lesson that produced the phrase ledger and the
 * register tracker). The note rides the SAME turn-boundary injection they do — see injectCoachNote
 * in agent.ts — so it costs one tail item and no prompt-cache churn.
 *
 * ── Why word count, and not an LLM read ───────────────────────────────────────────────────────
 *
 * An engagement classifier could be a model call. It would cost a round-trip on the caller's clock,
 * on the one path in this pipeline that is already over budget, to measure something a human judges
 * instantly by how long the other person talks. Length is a crude proxy and it is the RIGHT crude
 * proxy: a man giving four-word answers is not opening up, whatever the sentiment of the words.
 *
 * Pure, clock-free and injectable, so both halves unit-test deterministically.
 */

/** Hebrew backchannels and holds — sounds, not answers. A turn that is only these tells us nothing
 * about engagement and certainly does not earn a comprehension claim. */
const BACKCHANNEL =
  /^(?:[אה]{1,4}|אהה|אממ|המ+|כן|לא|נכון|בסדר|אוקיי|או?קי|טוב|סבבה|אחלה|מעולה|רגע|שנייה|יופי|תודה|הלו|מה|בטח|ברור)[\s.,!?…׃-]*$/u;

/** He is asking, not sharing. A question is a turn where the next thing she owes him is an ANSWER,
 * and "הבנתי אותך" in front of it is the receipt ritual he named. */
const QUESTION = /[?؟]/u;

/**
 * Words in a caller turn, counted the way a listener would.
 *
 * Punctuation-only tokens do not count, and neither does the em-dash furniture Soniox sprinkles
 * through a hesitant sentence. Digits count as one word each ("15 עד 20" is three), which is
 * deliberate: reading a number out loud IS talking.
 */
export function wordCount(utterance: string | null | undefined): number {
  if (!utterance) return 0;
  return utterance
    .trim()
    .split(/\s+/u)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * The floor for "he told me something".
 *
 * Four, from the call this comes from: *"אני מתעסק בבניית אתרים"* is four words and is the single
 * most substantive thing the caller said all call, while *"בכלל אני לבד"* (three) and *"מחר."*
 * (one) are answers she should receive with a plain "אוקיי." and nothing more. Set it at five and
 * the archetypal case fails; set it at three and "יש לי עוד." earns a comprehension claim.
 */
export const SUBSTANCE_MIN_WORDS = 4;

/**
 * Did the caller just share something worth saying "הבנתי" to?
 *
 * Deliberately strict — the cost of a false NO is one ordinary receipt ("אוקיי."), which is always
 * correct; the cost of a false YES is the thing Koren heard thirty-four times.
 */
export function callerSharedSubstance(utterance: string | null | undefined): boolean {
  if (!utterance) return false;
  const text = utterance.trim();
  if (!text) return false;
  if (QUESTION.test(text)) return false;
  if (BACKCHANNEL.test(text)) return false;
  return wordCount(text) >= SUBSTANCE_MIN_WORDS;
}

export type EngagementLevel = 'terse' | 'neutral' | 'engaged';

/** How many caller turns are averaged. Short enough to follow a call that opens up halfway
 * through, long enough that one stray "כן." does not re-classify the caller. */
export const ENGAGEMENT_WINDOW = 5;

/** Below this average he is not co-operating; the mandatory questions are all she gets to ask. */
export const TERSE_MAX_WORDS = 4;

/** At or above this he is talking to her; the optional questions become available. */
export const ENGAGED_MIN_WORDS = 11;

/** Nothing is claimed about a caller who has barely spoken — the greeting exchange alone is not
 * evidence of anything. */
export const ENGAGEMENT_MIN_TURNS = 3;

/**
 * A rolling read of how much the caller is giving her, and the note that tells her about it.
 *
 * The note fires ONLY on a change of level, so a whole call with a consistent caller produces one
 * line, and a caller who warms up produces two. An unchanged note is dropped upstream anyway
 * (injectCoachNote compares against the last one), but emitting it would still churn the tail item
 * on every turn for no reason.
 */
export class EngagementTracker {
  readonly #recent: number[] = [];
  #turns = 0;
  #notedLevel: EngagementLevel | null = null;
  /** True once she has replied, so the NEXT caller item starts a new turn rather than extending
   * the last one. See observeCaller. */
  #turnClosed = true;

  /**
   * One committed CALLER item — which is NOT the same thing as one caller turn.
   *
   * MEASURED, not anticipated. On the first local run of `natural_flow` after this shipped, the
   * caller's opening sentence arrived as three committed items — "היי." · "אה..." · "ראיתי את
   * המודעה שלכם באינסטגרם, ולא בדיוק הבנתי מה אתם עושים." — and a per-item average called that
   * caller TERSE. He is the opposite: he is the most talkative scenario in the harness. Koren's own
   * 2026-08-31 call reported `fragmentedTurns: 8` for the same reason, so this is not a synthetic
   * artefact.
   *
   * So items are COALESCED exactly the way the call report defines a fragment: two caller items in
   * a row with no reply between them are one turn. `observeAgentTurn` closes the turn.
   *
   * Backchannels are counted, not skipped: a man answering "כן." to everything is precisely the
   * terse caller this exists to notice.
   */
  observeCaller(utterance: string | null | undefined): void {
    const words = wordCount(utterance);
    if (words === 0) return;
    if (this.#turnClosed) {
      this.#turns += 1;
      this.#recent.push(words);
      if (this.#recent.length > ENGAGEMENT_WINDOW) this.#recent.shift();
      this.#turnClosed = false;
      return;
    }
    this.#recent[this.#recent.length - 1] = (this.#recent[this.#recent.length - 1] ?? 0) + words;
  }

  /** She replied — the caller's next words are a new turn, not a continuation of the last one. */
  observeAgentTurn(): void {
    this.#turnClosed = true;
  }

  get turns(): number {
    return this.#turns;
  }

  /** Mean words per caller turn over the window — the number the note quotes. */
  get averageWords(): number {
    if (this.#recent.length === 0) return 0;
    const sum = this.#recent.reduce((a, b) => a + b, 0);
    return Math.round((sum / this.#recent.length) * 10) / 10;
  }

  get level(): EngagementLevel {
    if (this.#turns < ENGAGEMENT_MIN_TURNS) return 'neutral';
    const avg = this.averageWords;
    if (avg <= TERSE_MAX_WORDS) return 'terse';
    if (avg >= ENGAGED_MIN_WORDS) return 'engaged';
    return 'neutral';
  }

  /**
   * The advisory line, or null when nothing has changed.
   *
   * It says what to DO, not what was measured — a model told "engagement 0.3" invents a policy for
   * it. Both branches name the mandatory/optional vocabulary the discovery bank uses, so the note
   * and the prompt are describing the same two lists.
   */
  note(): string | null {
    const level = this.level;
    if (level === this.#notedLevel) return null;
    if (level === 'neutral' && this.#notedLevel === null) return null;
    this.#notedLevel = level;
    const avg = this.averageWords;
    if (level === 'terse') {
      return (
        `[Caller engagement — automatic] His answers are short (about ${avg} words per turn). ` +
        'He is not going to sit through a questionnaire: ask ONLY the MANDATORY discovery ' +
        'questions, skip every OPTIONAL one, and move to offering the demo.'
      );
    }
    if (level === 'engaged') {
      return (
        `[Caller engagement — automatic] He is talking freely (about ${avg} words per turn). ` +
        'Once the MANDATORY discovery questions are answered you may add one or two OPTIONAL ' +
        'ones and go a little deeper — but still one question at a time.'
      );
    }
    return (
      `[Caller engagement — automatic] He is answering normally (about ${avg} words per turn). ` +
      'Cover the MANDATORY discovery questions; add an OPTIONAL one only if he opens up.'
    );
  }
}
