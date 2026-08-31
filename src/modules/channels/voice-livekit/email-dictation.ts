/**
 * THE EMAIL SHE CANNOT TAKE DOWN — spelling memory for an address read out over an 8kHz line.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-08-31 production, verbatim; his real address is
 * `kaskoren@gmail.com`):
 *
 *     527s  lead   "קו קורן שטרודל ג'ימייל נקודה קום."
 *     533s  KEREN  "אוקיי. רק שאדייק. זה k o r e n בג'ימייל נקודה קום?"
 *     538s  lead   "זה בהתחלה.  K.  A-F."              <- he contradicts it and starts spelling
 *     542s  lead   "K-O-R-E-N שטרודל ג'ימייל נקודה קום."
 *     549s  KEREN  "הבנתי אותךָ. רק לוודֵא. k o r e n at gmail dot com, נכון?"   <- the SAME value
 *     551s  lead   "לא נכון."
 *     565s  lead   "K-A.  F."
 *     568s  KEREN  "הבנתי"                              <- over the top of his letters
 *     568s  lead   "K-O-R-E-N."
 *     581s  KEREN  "…כרגע שמעתי גם k a f וגם k o r e n, ואני רוצָה לרשום את זה נכון."
 *
 * The call ended there, 54 seconds into one field, with no booking. The same defect had already
 * recorded `koren@gmail.com` on the previous call. It is the single defect that has cost a booking
 * twice, and it is FOUR failures wearing one coat:
 *
 *   1. the letters arrive FRAGMENTED — "K-A." then "F." then "K-O-R-E-N." are three turns and one
 *      address, and nothing joined them;
 *   2. she read back a value the lead had ALREADY contradicted, unchanged, twice;
 *   3. the model treated "k a f" and "k o r e n" as competing readings of the whole thing rather
 *      than as the front and the back of one string ("שמעתי גם … וגם …");
 *   4. she read it back in ENGLISH inside a Hebrew sentence, which over a phone line is the hardest
 *      possible thing to verify — the half of this that is prompt wording, and not in this file.
 *
 * ── Why memory and not a parser ───────────────────────────────────────────────────────────────
 *
 * This deliberately does NOT decide what the address is. Transliterating a Hebrew-spoken local part
 * into Latin is guesswork, and a confident wrong guess is exactly the failure above — she was very
 * sure about `koren`. What it does is keep the EVIDENCE the model kept losing between turns: every
 * single letter he has spelled, in the order he said it, across however many turns the endpointer
 * shredded his answer into; the domain, which IS deterministic ("ג'ימייל נקודה קום" is gmail.com in
 * every call that will ever happen); and the values he has said out loud are wrong.
 *
 * The rejection half is the important one. A value the lead has explicitly contradicted must never
 * come back — not in a read-back, not in `capture_lead_info`. That is enforced in fact-memory.ts
 * (`reject` / `guardIdentity`), because that is where "what may overwrite what" already lives; this
 * module is what NOTICES the rejection.
 *
 * ── Stateful, unlike dictation.ts, and bounded because of it ──────────────────────────────────
 *
 * `isDictationTurn` is deliberately stateless — a classifier that cannot get stuck. This one has to
 * hold state (letters accumulate across turns by definition), so the bounds are explicit: it only
 * collects while she has asked for the email and he has not confirmed one, the letter buffer resets
 * on every rejection and on every confirmation, and it holds at most MAX_LETTERS. A stuck collector
 * costs a note the model can ignore; it can never change what she says by itself.
 */

/** How many spelled letters we will hold before assuming something has gone wrong and stopping. */
export const MAX_LETTERS = 40;

/** She is asking for the email — start listening for letters. Mirrors fact-memory's ASK_PATTERNS. */
const EMAIL_ASK = /כתובת\s+ה?מייל|מה\s+ה?מייל|ה?אימייל|המייל\s+של(ך|ךָ)|מייל.{0,12}\?/u;

/**
 * The spoken furniture of a domain, and what it means. Hebrew first — this is what people actually
 * say into a phone — with the English forms Soniox also produces on a code-switched turn.
 *
 * ORDER MATTERS: the longest, most specific patterns first, so "ג'ימייל נקודה קום" is not consumed
 * by the bare "נקודה קום" rule.
 */
const DOMAIN_PATTERNS: Array<{ re: RegExp; domain: string }> = [
  { re: /ג'?ימייל|gmail/iu, domain: 'gmail.com' },
  { re: /הוטמייל|hotmail/iu, domain: 'hotmail.com' },
  { re: /אאוטלוק|outlook/iu, domain: 'outlook.com' },
  { re: /יאהו|yahoo/iu, domain: 'yahoo.com' },
  { re: /וואלה|walla/iu, domain: 'walla.co.il' },
];

/**
 * A whole address already in Latin — the shape her own read-back takes, and occasionally his.
 * Kept deliberately loose (no TLD whitelist): this is used to spot what she SAID, not to validate.
 */
const WRITTEN_EMAIL = /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]{2,}\.[A-Za-z]{2,}/u;

/**
 * The LOCAL PART she is proposing when she spells it out loud, as in
 * `"רק לוודֵא. k o r e n at gmail dot com, נכון?"` and `"זה k o r e n בג'ימייל נקודה קום?"`.
 *
 * Three letters minimum, and the domain is looked for SEPARATELY rather than required to follow an
 * "at": on the call this is written from she said the @ once in English ("at gmail dot com") and
 * once as a Hebrew prefix ("בג'ימייל"), and a pattern that insisted on the separator would have
 * caught the first read-back and missed the second — the one he then rejected.
 */
const SPELLED_LOCAL = /(?:\b[A-Za-z]\b[\s.-]+){2,}\b[A-Za-z]\b/u;

/**
 * "That is wrong" — said the way people say it, and ONLY as a rejection.
 *
 * `לא נכון` / `זה לא` / `טעות` are unambiguous. A bare `לא` is NOT: "לא, תמשיכי" and "לא משנה" are
 * not rejections of a read-back, so a bare `לא` counts only when it is the whole turn or the head of
 * a very short one. Being under-inclusive is the safe direction — a missed rejection leaves us where
 * we already are, while a false one would throw away a value the lead had just confirmed.
 */
const REJECTION = /לא\s+נכון|זה\s+לא\s+(זה|נכון)|טעות|לא\s+מדויק|לא\s+זה|^לא[.,!]?$|^לא\b.{0,12}$/u;

/** "Yes, that's it" — closes the collection so a later stray letter cannot reopen it. */
const CONFIRMATION = /^(כן|נכון|בדיוק|מעולה|יופי|זהו)\b|כן,?\s*(זה\s+)?נכון|זה\s+נכון/u;

/**
 * Single letters being SPELLED — one at a time, separated by dashes, dots or spaces.
 *
 * Matches the runs `dictation.ts` already recognises ("K-O-R-E-N", "K. A-F") and pulls the letters
 * out of them in order. The two-letter minimum is what keeps ordinary code-switching out: "AI",
 * "CRM" and "OK" appear in half the calls we make and are words, not spelling.
 */
const LETTER_RUN = /(?:\b[A-Za-z]\b[\s.,-]+){1,}\b[A-Za-z]\b/gu;

/**
 * ONE letter, alone, as the whole turn — "S." on the 2026-08-31 local run.
 *
 * `LETTER_RUN` needs two, because two is what separates spelling from a word. A turn that is
 * nothing but a single letter has no such ambiguity: nobody says "S." on its own except while
 * spelling. It is read ONLY while `collecting`, so it cannot fire in ordinary conversation, and it
 * is exactly the fragment the endpointer produces when it cuts a spelled run in half.
 */
const LONE_LETTER = /^[\s.,'"־-]*([A-Za-z])[\s.,'"־-]*$/u;

/** What we hand the model, and what the tests assert on. */
export interface EmailDictationSnapshot {
  /** Is she in the middle of collecting the address? */
  collecting: boolean;
  /** Every letter he has spelled since the last reset, in the order he said it. */
  letters: string[];
  /** The domain his spoken furniture resolves to, when it resolves to one. */
  domain: string | null;
  /** Values he has said out loud are WRONG. Never read back, never saved. */
  rejected: string[];
}

/**
 * Pull the spelled letters out of one utterance, in order.
 *
 * Exported because it is the whole of the "stitching" claim and deserves its own test: the bug is
 * that "K-A." and "F." and "K-O-R-E-N." are one address, and this is what says so.
 */
export function spelledLetters(utterance: string): string[] {
  const out: string[] = [];
  for (const run of utterance.match(LETTER_RUN) ?? []) {
    for (const ch of run.match(/[A-Za-z]/gu) ?? []) out.push(ch.toUpperCase());
  }
  return out;
}

/** The domain a spoken utterance names, or null. Deterministic — this half is never a guess. */
export function spokenDomain(utterance: string): string | null {
  for (const { re, domain } of DOMAIN_PATTERNS) {
    if (re.test(utterance)) return domain;
  }
  return null;
}

/**
 * The email value SHE just proposed out loud, so a "לא נכון" has something to attach to.
 *
 * Two shapes, because she uses both: a written address (`koren@gmail.com`) and a spelled one
 * (`k o r e n at gmail dot com`). The spelled one is normalised to the same written form, which is
 * what makes the rejection ledger comparable against whatever `capture_lead_info` later offers.
 */
export function readbackCandidate(utterance: string): string | null {
  const written = utterance.match(WRITTEN_EMAIL)?.[0];
  if (written) return written.toLowerCase();

  const spelled = SPELLED_LOCAL.exec(utterance)?.[0];
  if (!spelled) return null;
  const local = spelled.replace(/[^A-Za-z]/gu, '').toLowerCase();
  if (local.length < 3) return null;
  // A DOMAIN IS REQUIRED, and the local test loop is why. On the 2026-08-31 run she said
  // "רשמתי K-A-S. תמשיך בבקשה את כל הכתובת" — a progress report on a PARTIAL spelling, not an
  // address she was offering. The synthetic caller's scripted "לא נכון" then landed on it and the
  // ledger recorded «kas» as a value the lead had ruled out, which he never did. A read-back is a
  // proposal of the WHOLE address; if she has not named the domain, she is not proposing one yet.
  const domain = spokenDomain(utterance);
  return domain ? `${local}@${domain}` : null;
}

export class EmailDictation {
  #collecting = false;
  #letters: string[] = [];
  #domain: string | null = null;
  #lastReadback: string | null = null;
  readonly #rejected: string[] = [];
  /** Committed utterances already folded in — the preemptive-draft echo arrives twice. Same 20s
   * rule and the same reason as PhraseLedger.observe and FactMemory.observeAgentUtterance. */
  #seen: Array<{ text: string; at: number }> = [];

  snapshot(): EmailDictationSnapshot {
    return {
      collecting: this.#collecting,
      letters: [...this.#letters],
      domain: this.#domain,
      rejected: [...this.#rejected],
    };
  }

  /** Everything he has said is wrong — read by fact-memory's guard, and by the note. */
  get rejected(): readonly string[] {
    return this.#rejected;
  }

  /** One committed line of HERS: does it ask for the email, and what did it read back? */
  observeAgentUtterance(text: string, at: number = Date.now()): void {
    const trimmed = text?.trim();
    if (!trimmed || this.#isEcho(trimmed, at)) return;
    if (EMAIL_ASK.test(trimmed)) this.#collecting = true;
    const candidate = readbackCandidate(trimmed);
    if (candidate) {
      this.#lastReadback = candidate;
      // She only reads an address back while she is taking one down; a call where the ask itself
      // was phrased in a way EMAIL_ASK misses still gets the rejection ledger.
      this.#collecting = true;
    }
  }

  /**
   * One committed line of HIS. Returns the value he just rejected, if he rejected one — the caller
   * (agent.ts) hands that to FactMemory so the tool layer refuses it too.
   */
  observeCallerUtterance(text: string, at: number = Date.now()): string | null {
    const trimmed = text?.trim();
    if (!trimmed || this.#isEcho(trimmed, at)) return null;

    if (this.#lastReadback && REJECTION.test(trimmed)) {
      const wrong = this.#lastReadback;
      if (!this.#rejected.includes(wrong)) this.#rejected.push(wrong);
      this.#lastReadback = null;
      // His next attempt is a FRESH spelling of the whole thing. Keeping the old letters would
      // concatenate the rejected reading onto the corrected one, which is the model's own mistake
      // ("שמעתי גם k a f וגם k o r e n") in code form.
      this.#letters = [];
      return wrong;
    }

    if (this.#lastReadback && CONFIRMATION.test(trimmed) && spelledLetters(trimmed).length === 0) {
      // Settled. Stop collecting so a later "K" in some unrelated turn cannot reopen the field.
      this.#collecting = false;
      this.#letters = [];
      this.#lastReadback = null;
      return null;
    }

    if (!this.#collecting) return null;

    const lone = LONE_LETTER.exec(trimmed)?.[1];
    const letters = lone ? [lone.toUpperCase()] : spelledLetters(trimmed);
    if (letters.length > 0 && this.#letters.length < MAX_LETTERS) {
      this.#letters.push(...letters.slice(0, MAX_LETTERS - this.#letters.length));
    }
    const domain = spokenDomain(trimmed);
    if (domain) this.#domain = domain;
    return null;
  }

  /**
   * The turn-boundary note, or null when there is nothing to say.
   *
   * APPENDED at the tail with the other coach notes (see injectCoachNote) — the prompt-cache prefix
   * must not move. It states EVIDENCE, never a conclusion: the letters in order, the domain, and
   * what has been ruled out. Deciding the address is still the model's job; losing the letters
   * between turns was never supposed to be.
   */
  note(): string | null {
    if (!this.#collecting) return null;
    const parts: string[] = [];
    if (this.#letters.length > 0) {
      parts.push(
        `The lead is SPELLING his email address. Letters he has said so far, in order, across ` +
          `all of his turns: ${this.#letters.join(' ')}. They are ONE address read out in pieces, ` +
          `not competing versions of it — the phone endpointer splits a spelled name into several ` +
          `turns. Join them in that order (${this.#letters.join('').toLowerCase()}) unless he ` +
          `tells you otherwise.`,
      );
    }
    if (this.#domain) {
      parts.push(`The domain he named is «${this.#domain}» — that part is settled, do not re-ask it.`);
    }
    if (this.#rejected.length > 0) {
      parts.push(
        `He has ALREADY told you these are WRONG: ${this.#rejected.map((r) => `«${r}»`).join(', ')}. ` +
          `Never read any of them back to him again and never save one — repeating a value he has ` +
          `just rejected is what made the last attempt fail. The correct address DIFFERS from them, ` +
          `so a reading that comes out the same is a reading you have got wrong.`,
      );
    }
    if (parts.length === 0) return null;
    // ⚠️ THIS PARAGRAPH MUST AGREE WITH `EMAIL_COLLECTION` IN system-prompt.he.ts. It sits at the
    // TAIL of the context, several thousand tokens after the prompt, so where the two disagree
    // THIS one wins — and between the round-8 verdicts landing and 2026-08-31 they DID disagree.
    // The prompt was changed to Koren's round-8 answer (read the address back in ENGLISH letters,
    // domain included, and say how many there are) and this note still carried the previous one
    // (say the local part as a Hebrew WORD first). So the shipped instruction was quietly the
    // verdict he had already ruled against, on every call where the collector was running, with
    // every test in this repo green. Change the two together or not at all.
    parts.push(
      `Read the joined address back in ENGLISH letters, domain included, and say how many letters ` +
        `there are — "זה שמונה אותיות: k. a. s. k. o. r. e. n. נכון?" — so a piece the line ate is ` +
        `something he can HEAR is missing. Spell corrections in ENGLISH letter names, never Hebrew ` +
        `ones.`,
    );
    return ['[Email capture — automatic reminder]', ...parts].join(' ');
  }

  #isEcho(text: string, at: number): boolean {
    if (this.#seen.some((s) => s.text === text && at - s.at < 20_000)) return true;
    this.#seen.push({ text, at });
    if (this.#seen.length > 60) this.#seen = this.#seen.slice(-40);
    return false;
  }
}
