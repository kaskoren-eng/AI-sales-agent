/**
 * The last thing between the LLM and the caller's ear.
 *
 * Two failures on Koren's first Keren-v2 call, both caught only by reading the transcript, and both
 * things a prompt cannot reliably prevent — so they are stopped in code, at the point where text
 * becomes sound.
 *
 *
 * 1. SHE SAID A CONTROL TOKEN OUT LOUD. Twice.
 *
 *      [204s] KEREN  NO_RESPONSE_NEEDED
 *      [393s] KEREN  NO_RESPONSE_NEEDED
 *
 *    The v2 prompt is a RETELL prompt, and Retell has a convention: emit `NO_RESPONSE_NEEDED` and
 *    the platform stays silent. LiveKit has no such convention, so the string went straight to
 *    Cartesia and Cartesia read it aloud, in English, to a Hebrew caller who had just asked her to
 *    hold on. Nothing in a prompt will stop this reliably — the model is doing exactly what it was
 *    told. The platform has to honour it.
 *
 *
 * 2. SHE CLAIMED TO HAVE BOOKED A MEETING THAT DOES NOT EXIST.
 *
 *      [303s] KEREN  מעולה, שמחה לשמוע. קבעתי לך שיחת דמו למחר
 *      [413s] KEREN  ...הדמו למחר ב-10. תקבל אישור, תודה רבה ונדבר!
 *
 *    No calendar was touched. No tool was called — this agent HAS no tools yet. The lead hangs up
 *    believing he has a demo tomorrow at 10 and a confirmation on its way, and nobody ever rings
 *    him. That is worse than any crash, because it looks like success to everyone involved.
 *
 *    The prompt tells her to call `book_appointment_cal` before saying this. She cannot. So she
 *    says it anyway — a model instructed to use a tool it does not have will improvise the outcome.
 *    Until Phase 4 wires the tools, the ONLY safe thing is to stop the sentence from leaving.
 *
 *    We do not silence her — silence mid-sentence is its own failure. We REWRITE the claim into the
 *    truth: she is passing the request to the team. That is what actually happens.
 */

/** Retell's silence token. LiveKit has no such convention, so it must never reach the TTS. */
const NO_RESPONSE = /NO_RESPONSE_NEEDED/gi;

/**
 * Claims that a booking is DONE. Every one of these is a lie until Phase 4 wires the calendar.
 *
 * Deliberately narrow. "אני בודקת זמינות" ("I'm checking availability") is NOT here: it is only a
 * promise to look, which is annoying but not false. What is caught here is the completed act —
 * "I booked you", "it's confirmed", "you'll get a confirmation".
 */
const FALSE_BOOKING = [
  /קבעתי\s+לך[^.!?]*/gu, // "I have booked you..."
  /קבעתי\s+את[^.!?]*/gu,
  /סגרתי\s+לך[^.!?]*/gu, // "I've locked it in for you..."
  /תקבל[יי]?\s+אישור[^.!?]*/gu, // "you'll receive a confirmation..."
  /שלחתי\s+לך\s+אישור[^.!?]*/gu,
];

/** What she says instead — the truth about what actually happens right now. */
const TRUTH = 'אעביר את הבקשה לצוות ונחזור אליך לאישור מדויק';

/**
 * Guards a STREAM, sentence by sentence, so she starts speaking without waiting for the whole reply.
 *
 * THE FIRST VERSION OF THIS BUFFERED THE ENTIRE REPLY, AND IT COST 718ms PER TURN.
 *
 *   LLM first token   1020ms   <- when she COULD start speaking
 *   LLM full reply    1738ms   <- when she actually started, with the naive guard
 *
 * Koren, immediately: "היא הייתה קצת איטית מהרגיל, תנסה למצוא פתרון אחר." He was right. Making the
 * agent measurably slower on EVERY turn to defend against a claim she makes on ONE turn is a bad
 * trade, and I made it without measuring the cost first.
 *
 * Sentence granularity is the fix, and it is exactly the right granularity — not a compromise.
 * Every pattern we guard lives INSIDE one sentence: `NO_RESPONSE_NEEDED` is an entire utterance, and
 * "קבעתי לך שיחת דמו למחר" cannot straddle a full stop. So there is nothing to be gained by holding
 * more text than that, and ~700ms per turn to be lost by doing so.
 *
 * She now starts speaking as soon as her FIRST sentence is complete — which is what the streaming
 * TTS was always designed for.
 */
export async function* guardStream(input: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = '';

  const flush = function* (chunk: string): Generator<string> {
    const guarded = guardSpeech(chunk);
    for (const note of guarded.interventions) {
      console.log(`speech_guard ${JSON.stringify({ note, said: guarded.text.slice(0, 80) })}`);
    }
    // `silent` means the sentence was nothing but a control token — emit nothing at all.
    if (!guarded.silent && guarded.text) yield `${guarded.text} `;
  };

  for await (const chunk of input) {
    buffer += chunk;

    let end = sentenceEnd(buffer);
    while (end !== -1) {
      yield* flush(buffer.slice(0, end + 1));
      buffer = buffer.slice(end + 1);
      end = sentenceEnd(buffer);
    }
  }

  // The tail: a final sentence with no terminator, or a bare control token (which has none).
  if (buffer.trim()) yield* flush(buffer);
}

/**
 * Index of the first sentence terminator, or -1.
 *
 * Requires whitespace/end after the mark so a decimal or a time ("10:30", "ב-10.") does not split
 * the sentence in half and hand the TTS a fragment.
 */
function sentenceEnd(text: string): number {
  const m = /[.!?…׃](\s|$)/u.exec(text);
  return m ? m.index : -1;
}

export interface GuardResult {
  text: string;
  /** True when the entire utterance was a control token and she should say NOTHING. */
  silent: boolean;
  /** What was rewritten, for the call report. */
  interventions: string[];
}

/**
 * Cleans one utterance before it is spoken.
 *
 * Runs on the FULL reply, not on streaming fragments: a regex over a token stream would match half a
 * word and mangle it. The cost is that TTS starts after the LLM finishes rather than during — which
 * we can afford far more easily than we can afford telling a lead his meeting is booked when it is
 * not.
 */
export function guardSpeech(text: string): GuardResult {
  const interventions: string[] = [];
  let out = text;

  if (NO_RESPONSE.test(out)) {
    interventions.push('removed NO_RESPONSE_NEEDED (Retell control token)');
    out = out.replace(NO_RESPONSE, '').trim();
    // If that was the WHOLE reply, she is meant to stay silent — which is the correct behaviour when
    // a caller says "רגע" or "שנייה". Saying nothing is the point.
    if (out === '') return { text: '', silent: true, interventions };
  }

  for (const pattern of FALSE_BOOKING) {
    if (pattern.test(out)) {
      interventions.push(`rewrote a false booking claim: "${out.match(pattern)?.[0]?.slice(0, 50)}"`);
      out = out.replace(pattern, TRUTH);
    }
  }

  return { text: out.replace(/\s{2,}/gu, ' ').trim(), silent: false, interventions };
}
