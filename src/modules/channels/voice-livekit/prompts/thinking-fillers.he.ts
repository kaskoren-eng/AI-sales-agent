/**
 * The noise a person makes while thinking.
 *
 * WHY. Koren, mid-call, to the agent: "אוקיי. סיימת? אני פשוט לא מדבר, אני מחכה שתסיימי."
 * He could not tell whether she was thinking or had simply stopped talking, so he sat in silence
 * waiting for a machine that was also silent. The problem is not the delay — a human takes just as
 * long to answer a hard question. The problem is that a human FILLS the gap, and nobody minds.
 *
 * THESE ARE NOT SENTENCES, AND THAT IS THE POINT. He asked for exactly this: "not the full sentence,
 * just the noise that people do when they think." A filler that says something ("תן לי לבדוק את זה
 * בשבילך") is a reply, and it makes a promise she may not keep. A filler that just hesitates is
 * honest and costs nothing.
 *
 * They are also SHORT on purpose. Once the filler starts, the real answer queues behind it — so a
 * long filler does not soften the wait, it lengthens it. Every one of these is under a second.
 *
 * HEBREW, NOT TRANSLATED ENGLISH. "אממ" and "רגע" are what Israelis actually say. "בוא נראה" reads
 * naturally; "ובכן" would sound like a newsreader. This is the difference between an agent that
 * sounds like a person and one that sounds like a person translating.
 */
export const THINKING_FILLERS_HE = [
  'אממ...',
  'רגע...',
  'שנייה...',
  'אה...',
] as const;

/**
 * Never more than this many in one call, however slow the LLM gets.
 *
 * Koren, after the first call with fillers on: "she express too many times the thinking words and
 * phrases." It fired TWENTY-ONE TIMES in a seven-minute call — roughly every other turn, because
 * the v2 prompt is long and the LLM crosses the threshold constantly.
 *
 * A person hesitates once or twice in a conversation. Twenty-one times is not thinking, it is a
 * nervous tic, and it makes her sound LESS human, not more — which is the precise opposite of what
 * the feature is for. The threshold alone was not enough: the fix has to include a hard ceiling.
 */
export const MAX_FILLERS_PER_CALL = 3;

/**
 * And never two within this window, even on consecutive slow turns.
 * Back-to-back hesitation reads as a stutter.
 */
export const FILLER_COOLDOWN_MS = 45_000;

/**
 * Picks a filler that has NOT been used on this call.
 *
 * The rule used to be "never the same one twice RUNNING", and the 2026-08-29 call showed why that
 * is not enough: three fillers fired in 194 seconds and the caller heard the same word most of the
 * time ("אה..." at 29.3s, again later). Within a single short call, a repeat is a repeat — the
 * previous-one check only ever prevented the immediate stutter.
 *
 * `used` is the whole call's ledger, so with four words and a ceiling of three there is always a
 * fresh one. The fallback (everything used) exists only so this can never return undefined.
 */
export function pickThinkingFiller(used: readonly string[]): string {
  const fresh = THINKING_FILLERS_HE.filter((f) => !used.includes(f));
  const last = used[used.length - 1];
  const options = fresh.length > 0 ? fresh : THINKING_FILLERS_HE.filter((f) => f !== last);
  return options[Math.floor(Math.random() * options.length)]!;
}

/**
 * The per-call filler budget, in one place.
 *
 * WHY A LEDGER AND NOT THREE LOOSE COUNTERS. The counters used to live in the entrypoint closure,
 * which meant only the 2.5s think-timer could spend the budget. The turn opener now spends it too
 * (a step that follows a tool call opens with a hesitation instead of a second acknowledgement —
 * see chooseTurnOpener), and two spenders with one budget need a shared object or they double-spend
 * the cap and repeat each other's words.
 *
 * OFFER, THEN COMMIT — and that split is load-bearing. A filler is ARMED long before we know
 * whether it will be spoken: on a step whose only output is a tool call there is no reply to glue
 * it to, and `withFiller` drops it. Counting at arm time would burn the call's three fillers on
 * words nobody ever heard, which is exactly how a slow, tool-heavy call ends up silent.
 */
export class ThinkingFillerLedger {
  readonly #used: string[] = [];
  #lastUsedAt: number | null = null;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The words actually spoken so far, in order. */
  get used(): readonly string[] {
    return this.#used;
  }

  /**
   * A word to arm, or null when this call has had its share (ceiling reached, or too soon after
   * the last one). Costs nothing: an offer that is never committed leaves the budget untouched.
   */
  offer(): string | null {
    if (this.#used.length >= MAX_FILLERS_PER_CALL) return null;
    if (this.#lastUsedAt !== null && this.#now() - this.#lastUsedAt < FILLER_COOLDOWN_MS) return null;
    return pickThinkingFiller(this.#used);
  }

  /** Called when the word actually reached the caller's ear — the only thing that spends budget. */
  commit(filler: string): void {
    this.#used.push(filler);
    this.#lastUsedAt = this.#now();
  }
}
