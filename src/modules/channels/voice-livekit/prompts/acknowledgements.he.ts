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
 * other member is a receipt in any context: you can say "אוקיי." after a question and it still
 * only means *I heard you*. "כן." means *yes*, and the caller cannot know we were not answering.
 * The rule for anything added here: read it back after a QUESTION, not just after a fact.
 */
export const ACKNOWLEDGEMENTS_HE = ['אוקיי.', 'אהה.', 'בסדר.'] as const;

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
 * ⚠️ NEITHER HAS BEEN HEARD ON A PHONE LINE YET. Unlike the slang bank there is no round-5
 * screening for acknowledgements, and these are longer than the originals (~3-4 syllables against
 * 2), so they occupy more of the window the model is thinking in. Both facts need an ear on a real
 * call; VOICE_ACK_LEDGER_ENABLED=false restores the three-word bank exactly.
 */
export const ACKNOWLEDGEMENTS_HE_WIDE = [
  ...ACKNOWLEDGEMENTS_HE,
  'הבנתי אותך.',
  'טוב, הבנתי.',
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
  #deck: string[] = [];
  #last: string | null = null;
  readonly #counts = new Map<string, number>();
  /** Injectable so the shuffle is deterministic in tests; production uses Math.random. */
  readonly #random: () => number;

  constructor(bank: readonly string[] = ACKNOWLEDGEMENTS_HE_WIDE, random: () => number = Math.random) {
    this.#bank = bank;
    this.#random = random;
  }

  next(): string {
    if (this.#deck.length === 0) this.#refill();
    const word = this.#deck.pop()!;
    this.#last = word;
    this.#counts.set(word, (this.#counts.get(word) ?? 0) + 1);
    return word;
  }

  /** Distinct acknowledgements spoken 2+ times so far — what repeatedPhraseCount was missing. */
  get repeatedCount(): number {
    let n = 0;
    for (const c of this.#counts.values()) if (c >= 2) n++;
    return n;
  }

  #refill(): void {
    const deck = [...this.#bank];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.#random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    // pop() takes from the END, so the last element must not repeat the word we just said.
    if (deck.length > 1 && deck[deck.length - 1] === this.#last) {
      [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1]!, deck[0]!];
    }
    this.#deck = deck;
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
