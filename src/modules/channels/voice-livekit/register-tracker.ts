/**
 * DID SHE ACTUALLY TALK LIKE A PERSON, OR ONLY PROMISE TO?
 *
 * The Spoken Register section asks for an everyday word every second or third reply. On the
 * 2026-08-29 call it produced two in eight turns — `זה אחלה לעסקים` and `וואלה, מעניין` — and Koren
 * perceived neither. Perception is the acceptance test, so two-in-eight is a miss, not a partial
 * pass.
 *
 * This is the same shape as the phrase ledger, and for the same reason: the prompt is guidance, and
 * guidance degrades under context load. The previous session already proved the point in this exact
 * section — the register was in the prompt for a whole 194-second call and produced ZERO slang. It
 * was rewritten and produced two. A rule the model drifts away from needs something that notices.
 *
 * WHAT IT DOES: counts her committed replies and how many carried a word from the screened
 * vocabulary, and when TWO replies in a row go by without one, emits a note that is appended at the
 * turn boundary alongside the phrase-ledger note. It never rewrites her speech — register is an
 * authoring problem, and a regex inserting Hebrew slang into a finished sentence would produce
 * broken grammar.
 *
 * WHY IT MAY REPORT A TOUCH SHE DID NOT INTEND: `מעולה` is both a register word and an ordinary
 * adjective. That is a deliberate false-positive bias — over-counting makes the nudge fire LESS
 * often, so the failure mode is a missed reminder rather than nagging her about a call that already
 * sounds right.
 */
import { REGISTER_VOCABULARY } from './prompts/system-prompt.he.js';

/** Consecutive replies with no everyday word before the nudge fires. */
export const DRY_REPLIES_BEFORE_NUDGE = 2;

/** Does this line carry one of the screened everyday words? Exported for the call report. */
export function hasRegisterTouch(
  text: string,
  vocabulary: readonly string[] = REGISTER_VOCABULARY,
): boolean {
  // Substring, not word-boundary: Hebrew attaches prefixes (ו/ש/כ/ב/ל/מ/ה) directly to the word,
  // so "ובקטנה" is the same touch as "בקטנה" and a \b-anchored match would miss half of them.
  const stripped = text.replace(/[֑-ׇ]/gu, '');
  return vocabulary.some((word) => stripped.includes(word));
}

export class SpokenRegisterTracker {
  readonly #vocabulary: readonly string[];
  #replies = 0;
  #touched = 0;
  #dryStreak = 0;
  /** The reply that last triggered a note, so an unchanged situation is not re-announced. */
  #notedAtReply = 0;
  #seen: Array<{ text: string; at: number }> = [];

  constructor(vocabulary: readonly string[] = REGISTER_VOCABULARY) {
    this.#vocabulary = vocabulary;
  }

  /** One committed agent reply. Deduped against the preemptive-draft echo, same 20s rule as the
   * phrase ledger — a draft counted twice would make the hit rate read half its real value. */
  observe(text: string, at: number = Date.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.#seen.some((s) => s.text === trimmed && at - s.at < 20_000)) return;
    this.#seen.push({ text: trimmed, at });

    this.#replies += 1;
    if (hasRegisterTouch(trimmed, this.#vocabulary)) {
      this.#touched += 1;
      this.#dryStreak = 0;
    } else {
      this.#dryStreak += 1;
    }
  }

  get replies(): number {
    return this.#replies;
  }
  get touched(): number {
    return this.#touched;
  }
  get dryStreak(): number {
    return this.#dryStreak;
  }

  /**
   * The nudge, or null.
   *
   * Fires only on a NEW dry streak: once it has spoken for a given streak it stays quiet until a
   * touched reply resets it, so a long formal stretch produces one reminder rather than one per
   * turn. A call that keeps the quota never enters this path and costs nothing.
   */
  note(): string | null {
    if (this.#dryStreak < DRY_REPLIES_BEFORE_NUDGE) return null;
    if (this.#notedAtReply === this.#replies) return null;
    this.#notedAtReply = this.#replies;
    return (
      `[Spoken register — automatic reminder] Your last ${this.#dryStreak} replies carried no ` +
      'everyday word. Put ONE into your next reply — inside a sentence, never as the first word. ' +
      `Use only these: ${this.#vocabulary.join(', ')}.`
    );
  }
}
