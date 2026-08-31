import { openerKey } from '../spoken-openers.js';

/**
 * The word she says the instant she has heard you — before she knows what to answer.
 *
 * WHY THIS IS THE ONLY ROUTE UNDER A SECOND. Measured, not assumed: end-of-turn is ~400ms and the
 * LLM's time-to-first-token is ~974ms (`npm run bench:path`, gpt-5.4 on the real prompt). Even with
 * a perfect pipeline the first word of a real answer cannot arrive before ~1.6s, and no per-stage
 * tuning closes that — we spent three sessions proving it, most of them on preemptive generation.
 *
 * A human does not solve this by thinking faster. They say "אוקיי" while they think. That token
 * costs nothing to produce, so it lands at end-of-turn + TTS first byte ≈ 620ms, and the silence
 * the caller actually sits through ends there.
 *
 * THESE ARE RECEIPTS, NOT HESITATIONS — the distinction is the whole design.
 *
 * `THINKING_FILLERS_HE` ("אממ...", "רגע...") say *I am struggling*. Koren counted twenty-one of
 * them in a seven-minute call and called it what it was: a nervous tic. That is why those are
 * capped at three per call.
 *
 * These say *I heard you*, which is a different act. Real people produce them on nearly every
 * turn of a phone call and nobody notices, because they are the sound of being listened to. That
 * is why these have no per-call cap — they are meant to fire every turn.
 *
 * CHOSEN NOT TO COLLIDE WITH HER OWN OPENERS. On real calls she begins replies with "בשמחה.",
 * "מעולה.", "בטח.", "הבנתי.", "נשמע טוב.", "שאלה טובה." — so none of those appear here, or the
 * caller would hear the same word twice in a row. `dropEchoedOpener` catches the rest.
 *
 * AND NONE OF THEM MAY READ AS AN ANSWER. "כן." was in this list until 2026-08-29, when Koren
 * asked her "מה המצב, קרן?" and the call answered "כן." — a machine mishearing a greeting. Every
 * other member is a receipt in any context: you can say "אוקי." after a question and it still
 * only means *I heard you*. "כן." means *yes*, and the caller cannot know we were not answering.
 * The rule for anything added here: read it back after a QUESTION, not just after a fact.
 *
 * ── ROUND 10, 2026-08-31 — THE FIRST TIME ANY OF THESE WAS LISTENED TO ────────────────────────
 *
 * Every word here had been spoken on nearly every turn of every production call since the feature
 * shipped, and NOT ONE of them had ever been heard through a phone band by a native speaker. Round
 * 10 (`tests/hebrew-tts-niqqud-ab/index-round10.html`) put them in front of Koren in the carrier
 * production actually speaks them in. Two of the three moved:
 *
 *   - `אהה.` → **`אמ.`** (card `f1`, variant E). This is the word he complained about twice —
 *     *"היא אומרת 'או-ה' במקום 'אהההה' אחיד"*. Eight spellings were offered, including three
 *     pointed ones and the `אהההה` he proposed himself; he chose none of them and took a DIFFERENT
 *     SOUND. `אמ` closes the lips instead of opening the throat, so there is no second syllable for
 *     Cartesia to put a break into — the failure mode was structural, and no spelling of `אהה`
 *     could have fixed it.
 *   - `אוקיי.` → **`אוקי.`** (card `a1`, variant B), the single yod.
 *   - `בסדר.` — **KEPT**, explicitly (card `a2`). Pinned in acknowledgements.test.ts so a later
 *     tidy-up cannot quietly drop it.
 *
 * ⚠️ `אמ` AND `אֶממ...` NOW SHARE A STEM, and nothing in the category rule can see that. One is a
 * receipt, the other is a hesitation, and `mayPairInOneBreath` would happily put them in one
 * breath — "אמ. אֶממ..." — which is the stutter Koren ruled out in round 7 wearing a new face.
 * `turn-opener.ts` refuses a pair whose lead tokens share a stem for exactly this reason. That
 * guard is OURS, not his: he has never heard the pair, and it has never been on a call.
 */
export const ACKNOWLEDGEMENTS_HE = ['אוקי.', 'אמ.', 'בסדר.'] as const;

/**
 * THE TWO THAT ARE NOT RECEIPTS — they are claims, and a claim has to be true.
 *
 * Koren, 2026-08-31, on a ten-minute production call: *"הסוכן אמר 'טוב, הבנתי' או 'הבנתי אותך'
 * יותר מדי פעמים, וצריך באמת להגיע בהקשר כשהלקוח משתף מידע שרלוונטי לשיחה. לא סתם להגיד 'טוב,
 * הבנתי' על כל דבר."* The deck spoke one of these roughly every other turn — after "מחר.", after
 * "כן.", after a question — and `repeatedPhraseCount` came back 34.
 *
 * The distinction the wide bank missed: "אוקיי." means *I heard you* and is true after anything,
 * including a one-word answer and including a question. "הבנתי אותך." means *I have taken in what
 * you told me*, and after "מחר." there was nothing to take in. Said on every turn it stops being
 * listening and becomes the receipt ritual — the same defect as the mirrored compliment and the
 * "רק לוודא" preamble, wearing a different hat.
 *
 * So these leave the every-turn deck and become EARNED: `AcknowledgementLedger.next({ earned })`
 * only reaches for one when the caller's turn actually carried something
 * (`callerSharedSubstance`, engagement.ts) and the previous receipt was not one of these either.
 * They stay listed in ACKNOWLEDGEMENTS_HE_WIDE below because that constant is what
 * VOICE_ACK_EARNED_ENABLED=false restores and what the prompt shows the model.
 *
 * ROUND 10 HEARD BOTH AND KEPT BOTH WORDINGS UNCHANGED (cards `a3`, `a4` — variant A, the only
 * variant, "this is what she says today"). That is a verdict about SOUND and it does not reopen the
 * frequency question above: they are still earned, still capped, still never two in a row. The two
 * strings are pinned byte-for-byte in acknowledgements.test.ts so a later tidy-up cannot reword
 * something he has explicitly approved.
 */
export const ACK_COMPREHENSION_HE = ['הבנתי אותך.', 'טוב, הבנתי.'] as const;

/**
 * The widened bank (VOICE_ACK_LEDGER_ENABLED), and why widening is the only real lever.
 *
 * 2026-08-29: six of her eight turns opened with one of the three words above — "אהה." ×2,
 * "בסדר." ×2, "אוקיי." ×2 — and Koren heard the call as repetitive. He is right, and the
 * arithmetic says the no-repeat rule was never going to save it: over eight turns, three words
 * cannot be spread more evenly than "each one twice". Cycling makes the distribution perfect and
 * still leaves every word said twice. Only more words reduce how often a caller hears the same one.
 *
 * WHY ONLY TWO MORE. Every member has to survive two gates, and most candidates fail one:
 *   - It must still be a RECEIPT after a QUESTION. That is what killed "כן." ("מה המצב, קרן?" →
 *     "כן."), and it also rules out "טוב." (heard as "I'm good"), "ברור.", "נכון.", "סבבה.".
 *   - It must not be an opener she writes herself — "הבנתי.", "מעולה.", "בטח." are all hers, so a
 *     bare one of those risks the caller hearing the same word twice in a breath.
 * The two below are COMPOUND receipts: they lead with a word that cannot be mistaken for an answer
 * and they refer to hearing rather than agreeing, so they pass both gates where the bare forms do
 * not.
 *
 * ⚠️ BOTH HAVE NOW BEEN HEARD, AND THE VERDICT WAS NO — not on how they SOUND (the pronunciation
 * was fine) but on how often they were true. See ACK_COMPREHENSION_HE above: they are still in this
 * constant, because this is what VOICE_ACK_EARNED_ENABLED=false restores and what the prompt shows
 * the model, but the live deck no longer spends them like receipts.
 * VOICE_ACK_LEDGER_ENABLED=false restores the three-word bank exactly.
 */
export const ACKNOWLEDGEMENTS_HE_WIDE = [
  ...ACKNOWLEDGEMENTS_HE,
  ...ACK_COMPREHENSION_HE,
] as const;

/**
 * Spends the bank like a shuffled deck: every word is used once before any is used twice, and the
 * refill never repeats the word that ended the previous round.
 *
 * `pickAcknowledgement` below only avoids the IMMEDIATELY previous word, so across eight turns it
 * can and did land on "אהה, בסדר, אהה, אוקיי, אהה…". The deck cannot: the distribution is flat by
 * construction, which is the most a three-word bank can offer and still worth having on a five.
 *
 * `repeatedCount` is the honest counterpart of the CallReport metric — distinct words spoken 2+
 * times. It is deliberately NOT fed to the model: she does not write these words, we do, and a
 * note telling her to vary a word she never chose would be a lie about her own turn.
 */
export class AcknowledgementLedger {
  readonly #bank: readonly string[];
  /** The comprehension claims — drawn from only when the caller earned one. Empty disables them. */
  readonly #earned: readonly string[];
  #deck: string[] = [];
  #earnedDeck: string[] = [];
  #last: string | null = null;
  /** Whether the LAST word handed out was a comprehension claim, so two never run together. */
  #lastWasEarned = false;
  readonly #counts = new Map<string, number>();
  /** Injectable so the shuffle is deterministic in tests; production uses Math.random. */
  readonly #random: () => number;

  constructor(
    bank: readonly string[] = ACKNOWLEDGEMENTS_HE,
    random: () => number = Math.random,
    earned: readonly string[] = ACK_COMPREHENSION_HE,
  ) {
    this.#bank = bank;
    this.#random = random;
    // A word cannot be both an every-turn receipt and an earned claim — if a caller passes the WIDE
    // bank (the kill-switch path) the comprehension words are already in the deck, and offering
    // them twice would make the deck's flat distribution a lie.
    this.#earned = earned.filter((word) => !bank.includes(word));
  }

  /**
   * The next thing she says at the head of a turn.
   *
   * `earned` is the caller's last turn having actually carried something (see
   * `callerSharedSubstance`). It is a PERMISSION, not an instruction: a comprehension claim is only
   * used when it is earned AND the previous one was not also a claim, so even a caller who tells
   * her his life story hears "הבנתי אותך" at most every other turn.
   */
  next(opts: { earned?: boolean; avoid?: string | null } = {}): string {
    const avoid = opts.avoid ?? null;
    if (opts.earned === true && this.#earned.length > 0 && !this.#lastWasEarned) {
      if (this.#earnedDeck.length === 0) this.#earnedDeck = this.#shuffled(this.#earned);
      const claim = this.#take(this.#earnedDeck, avoid);
      if (claim !== null) {
        this.#last = claim;
        this.#lastWasEarned = true;
        this.#counts.set(claim, (this.#counts.get(claim) ?? 0) + 1);
        return claim;
      }
      // Every claim in the deck would repeat the last thing he heard. Fall through to a plain
      // receipt rather than say it again — a receipt is always true, so nothing is lost.
    }
    if (this.#deck.length === 0) this.#refill();
    // ── THE ESCAPE `consecutiveOpenerRepeats` WAS REPORTING ──────────────────────────────────
    //
    // This line used to be `this.#take(this.#deck, avoid) ?? this.#deck.pop()!`, and the fallback
    // handed back the very word `#take` had just refused. It fires whenever every word LEFT in a
    // part-used deck is the one the caller just heard — with a three-word bank and a window of one,
    // that is a deck down to its last card and that card being the blocked one.
    //
    // MEASURED, not reasoned about: 56 failures in 400 runs of `spoken-openers.test.ts`'s forty-turn
    // end-to-end case, i.e. a 14% flake on `npm run test:ci` that predates this branch — and every
    // single failure was the same pair, `אֶמ.` (the round-11 dictation nod) followed by `אמ.` (the
    // round-10 receipt). They are one sound: `openerKey` strips niqqud, so the tracker correctly
    // asked for `אמ` to be avoided and the deck handed it over anyway. That is almost certainly
    // what the 2026-08-31 16:51 production call's `consecutiveOpenerRepeats: 2` was — the metric's
    // own comment says a non-zero reading means "either a real escape or a producer nobody wired
    // in", and this is the escape.
    //
    // REFILL AND TRY AGAIN rather than pop the blocked word. The cost is that a one-card remainder
    // is occasionally discarded early, which bends the deck's flat distribution by a fraction of a
    // word per call; the alternative is the caller hearing the same sound twice running, which is
    // the exact complaint the whole mechanism exists for. Only the LAST resort — a bank in which
    // nothing legal exists at all, i.e. one word — still repeats, and it has no other option.
    //
    // With `avoid` null (VOICE_OPENER_NO_REPEAT_ENABLED off) `#take` never returns null on a
    // non-empty deck, so this is a no-op and the kill-switch still restores the old path exactly.
    let word = this.#take(this.#deck, avoid);
    if (word === null) {
      this.#refill();
      word = this.#take(this.#deck, avoid);
    }
    if (word === null) word = this.#deck.pop() ?? this.#bank[this.#bank.length - 1]!;
    this.#last = word;
    this.#lastWasEarned = false;
    this.#counts.set(word, (this.#counts.get(word) ?? 0) + 1);
    return word;
  }

  /**
   * Takes the next word off the end of a deck, skipping past one that would repeat `avoid`.
   *
   * `avoid` is the head-word of the PREVIOUS reply as the caller heard it — which may have come
   * from the nod, from a thinking filler or from the model itself, none of which touch this deck.
   * See SpokenOpenerTracker: the deck's own rotation was already measured clean, and the repeats
   * Koren heard came from mechanisms it could not see.
   *
   * With `avoid` null this is exactly `deck.pop()`, so the 2026-08-30 behaviour is unchanged when
   * nothing is being avoided. Returns null when every remaining word is blocked.
   */
  #take(deck: string[], avoid: string | null): string | null {
    if (deck.length === 0) return null;
    for (let i = deck.length - 1; i >= 0; i--) {
      const word = deck[i]!;
      if (avoid !== null && openerKey(word) === openerKey(avoid)) continue;
      deck.splice(i, 1);
      return word;
    }
    return null;
  }

  /** Distinct acknowledgements spoken 2+ times so far — what repeatedPhraseCount was missing. */
  get repeatedCount(): number {
    let n = 0;
    for (const c of this.#counts.values()) if (c >= 2) n++;
    return n;
  }

  #refill(): void {
    this.#deck = this.#shuffled(this.#bank);
  }

  #shuffled(source: readonly string[]): string[] {
    const deck = [...source];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.#random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    // pop() takes from the END, so the last element must not repeat the word we just said.
    if (deck.length > 1 && deck[deck.length - 1] === this.#last) {
      [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1]!, deck[0]!];
    }
    return deck;
  }
}

/**
 * Picks an acknowledgement, never the same one twice running.
 *
 * The no-repeat rule matters more here than for the thinking fillers, precisely BECAUSE these fire
 * every turn: "אוקיי. … אוקיי. … אוקיי." is not a person acknowledging you, it is a stuck record,
 * and it would undo the naturalness the feature exists to buy.
 */
export function pickAcknowledgement(previous: string | null): string {
  const options = ACKNOWLEDGEMENTS_HE.filter((a) => a !== previous);
  return options[Math.floor(Math.random() * options.length)]!;
}

/**
 * Drops the reply's opening word when it repeats the acknowledgement we already spoke.
 *
 * The acknowledgement is committed before the model has written a word, so unlike the old
 * prepended filler we cannot peek the opener and back out — by then the caller has heard it. This
 * is the other half of that trade: if the model also opens with "אוקיי", the duplicate is removed
 * from the text on its way to the TTS.
 *
 * Compares only the FIRST word, and only when it matches exactly after punctuation is stripped. A
 * reply that merely happens to contain the word later is left alone.
 */
export function dropEchoedOpener(ack: string, reply: string): string {
  const norm = (s: string): string => s.replace(/[.,!?…׃\s]+/gu, '');
  const ackWord = norm(ack);
  if (!ackWord) return reply;

  const match = /^\s*([^\s.,!?…׃]+)([.,!?…׃]*\s*)/u.exec(reply);
  if (!match) return reply;
  if (norm(match[1] ?? '') !== ackWord) return reply;

  return reply.slice(match[0].length);
}
