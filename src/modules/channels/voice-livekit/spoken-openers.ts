/**
 * THE WORD AT THE HEAD OF THE LAST THING SHE SAID — whichever mechanism produced it.
 *
 * Koren, 2026-08-31, after picking the earned acknowledgement on round-7 card `n6b`:
 * *"צריך לוודא שהסוכן לא חוזר על אותה מילה כל פעם בתחילת המשפט ('אוקיי')."*
 *
 * ── WHAT WAS ACTUALLY WRONG, MEASURED BEFORE ANYTHING WAS CHANGED ────────────────────────────
 *
 * The obvious suspect was `AcknowledgementLedger`, and it is innocent. Simulating it over 20,000
 * calls × 40 turns in each of its four configurations (3-word deck, 3-word deck with the earned
 * claims firing, the 5-word WIDE deck of the VOICE_ACK_EARNED_ENABLED=false path, and that deck
 * with claims requested) produced **zero** consecutive identical receipts. Its window is not one
 * turn and it is not absent: it is the whole deck — every word is spent before any repeats — plus
 * a boundary swap that stops a refill handing back the word that ended the previous round.
 *
 * The hole is that the deck is only ONE of four things that can occupy the head of a reply, and
 * none of them could see the others:
 *
 *   - the receipt from the deck (`ack`)
 *   - `DICTATION_NOD` — a single CONSTANT with no rotation at all, so two dictation turns running
 *     (a phone number, then an email) produce the same sound twice by construction
 *   - a thinking filler (`hesitation`)
 *   - on a `silent` step, whatever word the MODEL wrote — nothing rotates or compares those
 *
 * Nothing anywhere held the previous turn's spoken head word, so a cross-mechanism comparison was
 * not merely absent, it was not expressible. This class is that memory, and it is deliberately
 * about the SOUND THE CALLER HEARD rather than about any one producer.
 *
 * ── WHY THE OLD METRIC STAYED QUIET ──────────────────────────────────────────────────────────
 *
 * `repeatedOpenerCount` counts DISTINCT openers used twice or more across a call. Over a 37-turn
 * call a three-word bank must score 3 and a five-word bank must score 5, whatever the ordering —
 * perfect rotation and the same word every single turn are indistinguishable to it. It reported 4
 * on the call Koren is describing, and it would have reported 4 if the rotation had been flawless.
 * `countConsecutiveOpenerRepeats` (phrase-ledger.ts) is the number that can actually move.
 */

/** Punctuation that ends an opener but is not part of it. */
const OPENER_PUNCT = /[.,!?…׃]/gu;

/**
 * The comparison key for an opening sound: first token, punctuation and niqqud removed.
 *
 * Compared on the first token because that is the unit that repeats. Our injected `"אוקיי."` and a
 * model-written `"אוקיי, אז בוא נבדוק"` are the same opener to a listener even though the strings
 * differ, and a rule that only caught exact string equality would let precisely that pair through.
 */
export function openerKey(sound: string): string {
  const cleaned = sound
    .replace(/[֑-ׇ]/gu, '')
    .replace(OPENER_PUNCT, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.split(' ')[0] ?? '';
}

/**
 * One per call. Remembers the last head-word the caller actually heard and answers one question:
 * what may the next one not be?
 *
 * Deliberately a window of ONE. Koren's note is about consecutive turns — "not the same word every
 * time at the start of the sentence" — and widening the window would fight the deck rather than
 * help it: with a three-word bank, refusing the last TWO words leaves exactly one legal answer and
 * turns a shuffled deck into a fixed cycle, which is its own audible pattern.
 */
export class SpokenOpenerTracker {
  #last: string | null = null;

  /** The key the next opening sound must not match, or null on the first turn. */
  get avoid(): string | null {
    return this.#last;
  }

  /**
   * Records what the caller heard at the head of this reply. `null` (a step that opened with no
   * sound and whose first model word was not an opener) CLEARS the memory rather than keeping a
   * stale one: nothing was at the head, so nothing is being repeated by the next turn.
   */
  record(sound: string | null): void {
    this.#last = sound === null ? null : openerKey(sound) || null;
  }

  /** Would this sound repeat the previous head-word? */
  repeats(sound: string): boolean {
    return this.#last !== null && openerKey(sound) === this.#last;
  }
}

/**
 * The model's own opening word, IF its first chunk already contains one — and never at the price of
 * a wait.
 *
 * Used only on a `silent` step, where nothing of ours is in front of the model's text and its first
 * word is therefore the head of the breath. This function does not buffer, does not await an extra
 * chunk and does not rewrite anything: a `silent` step is by definition one that already has no
 * sound covering it (it follows a tool call whose round-trip the caller has just sat through), and
 * buffering its first audio to tidy a repetition would spend the one thing this module protects.
 *
 * So the model's word is OBSERVED, not policed. The consequence is stated rather than hidden: the
 * next opening sound WE choose will avoid it, but two consecutive `silent` steps could in principle
 * repeat. Under the production default (VOICE_INSTANT_ACK on) the first step of every caller turn
 * opens with a sound we chose, so that case needs two tool calls inside one reply.
 */
export function readLeadingOpener(chunk: string): string | null {
  const match = /^\s*([^\s.,!?…׃]+)\s*[.,!?…׃]/u.exec(chunk.replace(/[֑-ׇ]/gu, ''));
  const word = match?.[1] ?? '';
  if (!word || /^\d+$/u.test(word)) return null;
  return word;
}

/**
 * Reports the model's own opening word as its first chunk goes past — a passthrough with a
 * counter, deliberately not a filter.
 *
 * Same shape and same reason as `timeFirstChunk`: instrumentation that changes the timing it is
 * measuring is worse than none, and this sits on the one path (`silent` opener, no armed filler)
 * where the model's first token IS the caller's first audio.
 */
export async function* observeFirstOpener(
  stream: AsyncIterable<string>,
  onOpener: (word: string | null) => void,
): AsyncIterable<string> {
  let seen = false;
  for await (const chunk of stream) {
    if (!seen && chunk.trim()) {
      seen = true;
      onOpener(readLeadingOpener(chunk));
    }
    yield chunk;
  }
}
