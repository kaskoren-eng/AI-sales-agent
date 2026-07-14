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
 * Picks a filler, never the same one twice running.
 *
 * A repeated filler is worse than none: "אממ... אממ..." is not thinking, it is a stuck record, and
 * it is the fastest way to make her sound like a machine again — which is the whole thing this is
 * meant to prevent.
 */
export function pickThinkingFiller(previous: string | null): string {
  const options = THINKING_FILLERS_HE.filter((f) => f !== previous);
  return options[Math.floor(Math.random() * options.length)]!;
}
