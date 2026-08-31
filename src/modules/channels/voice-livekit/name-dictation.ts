/**
 * THE SURNAME SHE COULD NOT TAKE DOWN — spelling memory for a HEBREW name over an 8kHz line.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-08-31 16:51 production; his surname is `שטרית`):
 *
 *     [278s] lead   "אממ, יש לי.  טריט."
 *     [282s] KEREN  "בסדר. איך מאייתים את שם המשפחה?"
 *     [287s] lead   "עם ט-ר.  י."                      <- he starts spelling
 *     [288s] lead   "ת."                               <- the endpointer cuts it here
 *     [289s] KEREN  "אמ."
 *     [294s] KEREN  "אוקי. טריט, נכון? מה מספר הטלפון שלךָ?"   <- the letters were never used
 *     [303s] lead   "מה השם משפחה שרשמת?"
 *     [313s] lead   "שפיץ.  טריט."
 *     [320s] KEREN  "אוקי. שפיץ טריט, נכון? ומה כתובת המייל?"  <- two garbled readings, joined
 *
 * She asked him to spell it, he spelled `ט · ר · י · ת` across two turns, and nothing in the
 * pipeline joined them — the letters went past and she read back the same garbled word she already
 * had. Then two separate mishearings of one word were concatenated into a first-and-last name and
 * read back as if it were his.
 *
 * ── Why this is NOT email-dictation.ts with a different regex ─────────────────────────────────
 *
 * `email-dictation.ts` stitches spelled letters across the turns the endpointer shreds, which is
 * exactly the mechanism missing here — so the SHAPE generalises: ask-scoped collection, evidence
 * across turns, a note that states what was heard and never what it means. None of the CODE does.
 * Its character classes are `[A-Za-z]` throughout; its ask patterns are the email ones; its domain
 * table and its `local@domain` read-back detector have no counterpart in a name. Rewriting it to
 * carry both would give one stateful collector two ask-scopes that overlap in Step 4 — she asks
 * for the name and the email forty seconds apart — and a letter buffer that could not say which
 * field it belonged to. Two small collectors, one per field, is the cheaper thing to be right
 * about. What IS shared is the doctrine, and it is repeated here because it is the load-bearing
 * part: this module never decides what the name is.
 *
 * ── The Hebrew problem, which is the opposite of the Latin one ────────────────────────────────
 *
 * A spelled Latin letter is unambiguous — a lone `S` is never a word. A lone Hebrew letter is a
 * different matter, except that it is not: Hebrew's one-letter words (ב, ל, כ, ה, ו, מ, ש) are
 * PREFIXES and are written joined to the word they govern, so they never appear isolated in a
 * transcript. That is what `ISOLATED_HEBREW_LETTER` keys on — a Hebrew letter with no Hebrew
 * character on either side of it. It reads `ט` and `ר` out of "עם ט-ר." and leaves both letters of
 * "עם" alone, without needing to know what either means. And it only ever runs while she has just
 * asked him to spell something, which is the same bound the email collector uses.
 */

/** How many spelled letters we hold before assuming something has gone wrong and stopping. */
export const MAX_NAME_LETTERS = 24;

/** How many of her read-backs of the name we remember. Two is already the news. */
const MAX_READBACKS = 4;

/**
 * She is asking for the name, or for its spelling — start listening for letters.
 *
 * Wider than `fact-memory.ts`'s `ASK_PATTERNS.name` on purpose: that one COUNTS asks and must not
 * over-count, while this one only opens a listening window, and a window opened one turn early
 * costs nothing. "איך מאייתים" is the important entry — it is the question she actually asked, and
 * it is the one no other pattern in the repo matches.
 */
const NAME_SPELLING_ASK =
  /איך\s+מאייתים|תאיית|לאיית|באיות|שם\s+ה?משפחה|ה?שם\s+המלא|איך\s+כותבים\s+את\s+ה?שם/u;

/**
 * A Hebrew letter with no Hebrew character (letter OR niqqud) on either side of it.
 *
 * U+0590–U+05FF is the whole Hebrew block, so the lookarounds also reject a letter that carries a
 * vowel mark — which keeps this idempotent against the speech guard's own pointed output.
 */
const ISOLATED_HEBREW_LETTER = /(?<![֐-׿])([א-ת])(?![֐-׿])/gu;

/** The same, for a Hebrew name someone chooses to spell in Latin ("S. H. T. R. I. T."). */
const ISOLATED_LATIN_LETTER = /(?<![A-Za-z])([A-Za-z])(?![A-Za-z])/gu;

/**
 * The name SHE just read back — "טריט, נכון?", "שפיץ טריט, נכון?", "השם משפחה הוא שפיץ?".
 *
 * At most two words, because the thing being read back is a name and the sentence around it is
 * not. Anchored on the confirmation word so it cannot drift into ordinary prose.
 */
const NAME_READBACK: RegExp[] = [
  /([א-ת]{2,}(?:\s+[א-ת]{2,})?)\s*[,،]?\s*(?:נכון|נכונה)\s*\?/u,
  /ה?שם\s+ה?משפחה\s+(?:הוא|זה|היא)\s+([א-ת]{2,}(?:\s+[א-ת]{2,})?)/u,
];

/**
 * "That is wrong". Same wording and the same under-inclusive bias as `email-dictation.ts`'s
 * REJECTION — a missed rejection leaves us where we are, a false one throws away a good value.
 */
const REJECTION = /לא\s+נכון|זה\s+לא\s+(זה|נכון)|טעות|לא\s+מדויק|לא\s+זה|^לא[.,!]?$|^לא\b.{0,12}$/u;

/** "Yes, that's it" — closes the window so a later stray letter cannot reopen it. */
const CONFIRMATION = /^(כן|נכון|בדיוק|מעולה|יופי|זהו)\b|כן,?\s*(זה\s+)?נכון|זה\s+נכון/u;

/** Final letter forms, and the ordinary form each one is spelled as. */
const FINAL_TO_REGULAR: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const REGULAR_TO_FINAL: Record<string, string> = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };

/**
 * Joins spelled letters into a readable Hebrew word.
 *
 * A man spelling `שטרית` says the ordinary form of every letter; a man spelling `כץ` says `צ` and
 * means `ץ`. Writing the letters out verbatim gives `כצ`, which is not a Hebrew word and which the
 * model would then read back as one. So: every letter to its ordinary form, and the LAST one to
 * its final form if it has one. Purely cosmetic — it changes how the note READS, never which
 * letters were heard (`letters` keeps them exactly as they arrived).
 */
export function joinHebrewLetters(letters: readonly string[]): string {
  if (letters.length === 0) return '';
  const body = letters.map((ch) => FINAL_TO_REGULAR[ch] ?? ch);
  const last = body[body.length - 1]!;
  body[body.length - 1] = REGULAR_TO_FINAL[last] ?? last;
  return body.join('');
}

/** Every isolated letter in one utterance, in the order it was said. */
export function spelledNameLetters(utterance: string): string[] {
  const out: Array<{ index: number; ch: string }> = [];
  for (const m of utterance.matchAll(ISOLATED_HEBREW_LETTER)) {
    out.push({ index: m.index ?? 0, ch: m[1]! });
  }
  for (const m of utterance.matchAll(ISOLATED_LATIN_LETTER)) {
    out.push({ index: m.index ?? 0, ch: m[1]!.toUpperCase() });
  }
  return out.sort((a, b) => a.index - b.index).map((x) => x.ch);
}

/** The name she just proposed out loud, or null. */
export function nameReadback(utterance: string): string | null {
  for (const re of NAME_READBACK) {
    const found = re.exec(utterance)?.[1]?.trim();
    if (found) return found;
  }
  return null;
}

export interface NameDictationSnapshot {
  collecting: boolean;
  letters: string[];
  readbacks: string[];
  rejected: string[];
}

export class NameDictation {
  #collecting = false;
  #letters: string[] = [];
  #lastReadback: string | null = null;
  readonly #readbacks: string[] = [];
  readonly #rejected: string[] = [];
  /** Committed utterances already folded in — the preemptive-draft echo arrives twice. Same 20s
   * rule and the same reason as PhraseLedger.observe and FactMemory.observeAgentUtterance. */
  #seen: Array<{ text: string; at: number }> = [];

  snapshot(): NameDictationSnapshot {
    return {
      collecting: this.#collecting,
      letters: [...this.#letters],
      readbacks: [...this.#readbacks],
      rejected: [...this.#rejected],
    };
  }

  /** Everything he has said is wrong — read by the note, and by agent.ts's FactMemory bridge. */
  get rejected(): readonly string[] {
    return this.#rejected;
  }

  /** One committed line of HERS: does it ask for the name, and what did it read back? */
  observeAgentUtterance(text: string, at: number = Date.now()): void {
    const trimmed = text?.trim();
    if (!trimmed || this.#isEcho(trimmed, at)) return;
    if (NAME_SPELLING_ASK.test(trimmed)) this.#collecting = true;
    const candidate = nameReadback(trimmed);
    if (candidate) {
      this.#lastReadback = candidate;
      this.#collecting = true;
      if (!this.#readbacks.includes(candidate) && this.#readbacks.length < MAX_READBACKS) {
        this.#readbacks.push(candidate);
      }
    }
  }

  /**
   * One committed line of HIS. Returns the value he just rejected, if he rejected one — the caller
   * hands that to FactMemory so a refused name can never be saved or spoken again.
   */
  observeCallerUtterance(text: string, at: number = Date.now()): string | null {
    const trimmed = text?.trim();
    if (!trimmed || this.#isEcho(trimmed, at)) return null;

    if (this.#lastReadback && REJECTION.test(trimmed)) {
      const wrong = this.#lastReadback;
      if (!this.#rejected.includes(wrong)) this.#rejected.push(wrong);
      this.#lastReadback = null;
      // His next attempt is a FRESH spelling of the whole word. Keeping the old letters would
      // concatenate a rejected reading onto the corrected one — which is the model's own mistake
      // ("שפיץ טריט") in code form.
      this.#letters = [];
      return wrong;
    }

    if (this.#lastReadback && CONFIRMATION.test(trimmed) && spelledNameLetters(trimmed).length === 0) {
      this.#collecting = false;
      this.#letters = [];
      this.#lastReadback = null;
      return null;
    }

    if (!this.#collecting) return null;

    const letters = spelledNameLetters(trimmed);
    if (letters.length > 0 && this.#letters.length < MAX_NAME_LETTERS) {
      this.#letters.push(...letters.slice(0, MAX_NAME_LETTERS - this.#letters.length));
    }
    return null;
  }

  /**
   * The turn-boundary note, or null when there is nothing to say.
   *
   * States EVIDENCE, never a conclusion — the letters in order, the readings she has already
   * offered him, and what he has ruled out. Deciding the name is still the model's job.
   */
  note(): string | null {
    if (!this.#collecting) return null;
    const parts: string[] = [];

    if (this.#letters.length > 0) {
      const joined = joinHebrewLetters(this.#letters);
      parts.push(
        `The lead is SPELLING his name. Letters he has said so far, in order, across all of his ` +
          `turns: ${this.#letters.join(' ')}. They are ONE name read out in pieces, not competing ` +
          `versions of it — the phone endpointer splits a spelled word into several turns. Join ` +
          `them in that order («${joined}») and read THAT back to him, letter by letter, rather ` +
          `than the word you thought you heard before he started spelling.`,
      );
    }

    if (this.#readbacks.length > 1) {
      parts.push(
        `You have already read these back to him as his name: ${this.#readbacks
          .map((r) => `«${r}»`)
          .join(', ')}. You asked for ONE name, so these are competing mishearings of the SAME ` +
          `word — never two words of one name. Do not join them together and read the pair back ` +
          `as a full name. Ask him to spell it and use the letters.`,
      );
    }

    if (this.#rejected.length > 0) {
      parts.push(
        `He has ALREADY told you these are WRONG: ${this.#rejected.map((r) => `«${r}»`).join(', ')}. ` +
          `Never say one of them back to him again and never save it.`,
      );
    }

    if (parts.length === 0) return null;
    return ['[Name capture — automatic reminder]', ...parts].join(' ');
  }

  #isEcho(text: string, at: number): boolean {
    if (this.#seen.some((s) => s.text === text && at - s.at < 20_000)) return true;
    this.#seen.push({ text, at });
    if (this.#seen.length > 60) this.#seen = this.#seen.slice(-40);
    return false;
  }
}
