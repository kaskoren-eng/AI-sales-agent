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

/**
 * THE TURN SHE IS ACTUALLY ANSWERING — and why `lastUserUtterance` was not it.
 *
 * 2026-08-31 19:54. Koren's conclusion 1: *"טוב, הבנתי"* still lands at the wrong moment. It was
 * spoken five times on a 22-turn call (50s, 118s, 178s, 208s, 270s), and `callerSharedSubstance`
 * was supposed to have stopped four of them.
 *
 * WHAT I ESTABLISHED, from the call report rather than by reasoning about the code. Line up each
 * claim with the caller turn it followed, and with the turn BEFORE that:
 *
 *   50s  "טוב, הבנתי."   after "איך את יודעת שיש לי עסק, למשל?"   (a question → NOT earned)
 *                        one turn earlier: "לא, תפסת אותי בזמן מעולה."   (5 words → earned)
 *   118s "הבנתי אותךָ."  after "את יכולה להסביר לי מה אתם עושים?"  (a question → NOT earned)
 *                        one turn earlier: "יש לי עסק של בניית אתרים."   (5 words → earned)
 *   208s "טוב, הבנתי."   after "הוא מתקשר ללידים במקומי?"          (a question → NOT earned)
 *                        one turn earlier: "רגע, רגע. כן. סליחה..."      (7 words → earned)
 *   270s "הבנתי אותךָ."  after "כן, מרגיש לך."                     (3 words  → NOT earned)
 *                        one turn earlier: "לא יודע. נשמע לי..."          (long   → earned)
 *
 * Four for four, the substance test was reading the PREVIOUS caller turn. The mechanism is
 * preemptive generation: `llmNode` runs during the end-of-turn wait (17 of 24 drafts were used on
 * this call), while `agent.lastUserUtterance` is written from `ConversationItemAdded`, which fires
 * when the turn COMMITS — after the draft has already chosen its opener. The field is one turn
 * behind on every step where the draft is used, and the existing comment in agent.ts says as much
 * ("same source and same staleness as midDictation above") without anyone having priced it.
 *
 * So the fix is NOT a second suppressor on top of the first. It is to ask the same question of the
 * right text: `chatCtx` is what the model is answering, so its last user message IS the current
 * turn, by construction, draft or no draft.
 *
 * Shape-tolerant on purpose — this reads an SDK object across a version boundary, and a `textContent`
 * that becomes a getter, a null, or an array of parts must degrade to "no text" rather than throw
 * inside the reply path. Returning null makes the opener a plain receipt, which is always true.
 */
export function latestCallerText(
  items: ReadonlyArray<{ role?: unknown; textContent?: unknown }> | null | undefined,
): string | null {
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { role?: unknown; textContent?: unknown } | undefined;
    if (!item || item.role !== 'user') continue;
    const text = item.textContent;
    return typeof text === 'string' && text.trim() ? text : null;
  }
  return null;
}

/**
 * DOES THIS TURN NEED A RECEIPT AT ALL — Koren's twelfth conclusion, 2026-09-01.
 *
 * His decision, verbatim: *"Yeah, make that rule weakened. Every turn can be a bit problem.. but
 * instead its better to instruct the agent to use it on every long thinking turn or a complex
 * answer."*
 *
 * The short opener was never a style choice — it is a LATENCY device. Her voice starts only once
 * the first sentence is complete, so a 2-4 word sentence flushes through `guardStream` at once and
 * covers the ~930ms gpt-5.4 spends thinking. It buys nothing when the reply that follows is one
 * short line, because a short reply generates fast anyway: there is no gap to cover, and the receipt
 * is pure cost. **So this is latency-optimal, not a latency sacrifice** — which is the opposite of
 * what the Speech Rhythm section used to assert, and the reason his instinct is right on both axes.
 *
 * WHICH TURNS. A caller who ASKS something is owed an explanation; a caller who has just told her
 * twenty words is owed a real response. A man saying "אני קורן." or "כן." or "אוקיי." is owed the
 * next sentence, not a receipt for the last one.
 *
 * THE THRESHOLD IS MEASURED AGAINST THE CALL, not chosen. Replaying the 2026-08-31 19:54 transcript
 * through this predicate turns 22 receipts into 11, and every one it removes is one that reads badly
 * in the transcript — including all three of the stray standalone receipts, which were whole
 * committed agent turns consisting of one word:
 *
 *   [156s] "אוקי."   after the caller's turn was the single fragment "אני—"
 *   [195s] "בסדר."   after "רגע, רגע. כן. סליחה. שנייה. לא הבנתי."
 *   [272s] "בסדר."   after his last word of the call, "כן."
 *
 * and it keeps every receipt that reads well, including the one at 178s that follows twenty words
 * about how much time he loses. Ten words rather than eleven (`ENGAGED_MIN_WORDS`) because that
 * constant answers a different question — how talkative the caller is across a window — and the two
 * would drift into each other if they shared a number.
 *
 * NULL IS AN ACK, NOT A SILENCE. A missing caller turn means the classifier could not read the
 * context, and the safe direction for a degradation is the behaviour that shipped.
 */
export const ACK_MIN_SHARE_WORDS = 10;

export function callerTurnNeedsThinkingTime(utterance: string | null | undefined): boolean {
  if (utterance === null || utterance === undefined) return true;
  const text = utterance.trim();
  if (!text) return true;
  if (QUESTION.test(text)) return true;
  if (BACKCHANNEL.test(text)) return false;
  return wordCount(text) >= ACK_MIN_SHARE_WORDS;
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
