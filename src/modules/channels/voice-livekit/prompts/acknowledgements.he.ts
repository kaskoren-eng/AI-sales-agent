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
