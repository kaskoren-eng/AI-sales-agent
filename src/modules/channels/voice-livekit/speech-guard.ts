import { dropEchoedOpener } from './prompts/acknowledgements.he.js';

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
 *    `NO_RESPONSE_NEEDED` is inherited from the previous voice platform, where emitting it made
 *    the platform stay silent. Our stack has no such convention, so the string went straight to
 *    Cartesia and Cartesia read it aloud, in English, to a Hebrew caller who had just asked her to
 *    hold on. Nothing in a prompt will stop this reliably — the model is doing exactly what it was
 *    told. The platform has to honour it, so we honour it here.
 *
 *    The prompt (system-prompt.he.ts) still instructs the model to emit it for holds. That is
 *    deliberate: the token plus this guard IS the hold mechanism now. Do not remove either half
 *    without removing the other, and not without a real call to verify.
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

/**
 * ============================================================================================
 * THE GENDER FIX. This is a TTS bug, not an LLM bug, and it is invisible in every transcript.
 * ============================================================================================
 *
 * Hebrew writes the 2nd-person suffix pronouns IDENTICALLY for a man and a woman:
 *
 *     שלך   = shel-KHA (m)  /  shel-AKH (f)
 *     לך    = le-KHA   (m)  /  lakh     (f)
 *     אותך  = ot-KHA   (m)  /  ot-AKH   (f)
 *
 * Same letters. Only the vowels differ, and Hebrew does not write vowels. So Cartesia has to GUESS
 * — and Koren's report is that it guesses at random: "אותה מילה, פעם זכר פעם נקבה." A male lead
 * hears himself addressed as a woman, halfway through a sentence, unpredictably.
 *
 * The LLM is innocent. It writes the correct word every time; the transcript is always right. Only
 * the caller's ear can catch this.
 *
 * WHAT DID NOT WORK: niqqud (שֶׁלְּךָ). Cartesia accepts it and still mispronounces — Koren confirmed
 * the inconsistency persisted with it in the prompt.
 *
 * WHAT DOES WORK: spell the word PHONETICALLY so there is nothing left to guess. The TTS does not
 * read Hebrew — it reads letters and makes sounds. "שלכה" has no ambiguous vowel: it can only be
 * shel-KHA.
 *
 * VERIFIED, not assumed. Synthesized "מה מספר הטלפון שלכה?", squeezed it through an 8kHz phone
 * line, and transcribed it back with Soniox:
 *
 *     sent:  מה מספר הטלפון שלכה?
 *     heard: מה מספר הטלפון שלך?     <- a real Hebrew word, in the masculine
 *
 * Cartesia pronounced correct masculine Hebrew. The spelling is non-standard and NOBODY EVER SEES
 * IT — it exists for exactly the few milliseconds between the LLM and the speaker.
 *
 * AND THIS IS WHY IT IS DONE HERE AND NOT IN THE PROMPT. The first attempt BANNED these words in
 * the system prompt, with a table of replacements. Koren, immediately: "אל תגדיר אותם כמילים
 * אסורות, זה לא פתרון." He is right. Crippling her vocabulary to work around a pronunciation bug
 * makes her speak like a foreigner. She writes natural Hebrew; the pipeline fixes the sound.
 */
const SECOND_PERSON_MASCULINE: Array<[RegExp, string]> = [
  // Lookarounds, not \b — Hebrew letters are not word characters in JS regex, so \b matches in the
  // MIDDLE of a Hebrew word and would corrupt "משלך", "הלך", "שלכם".
  [/(?<![֐-׿])שלך(?![֐-׿])/gu, 'שלכה'],
  [/(?<![֐-׿])לך(?![֐-׿])/gu, 'לכה'],
  [/(?<![֐-׿])אותך(?![֐-׿])/gu, 'אותכה'],
  [/(?<![֐-׿])אליך(?![֐-׿])/gu, 'אליכה'],
  [/(?<![֐-׿])איתך(?![֐-׿])/gu, 'איתכה'],
  [/(?<![֐-׿])בשבילך(?![֐-׿])/gu, 'בשבילכה'],
  [/(?<![֐-׿])עבורך(?![֐-׿])/gu, 'עבורכה'],
];

/**
 * Forces the 2nd-person pronouns to be PRONOUNCED in the masculine, without changing a word the LLM
 * chose. Applied to what Cartesia is asked to say — never to what is stored, logged or transcribed.
 *
 * Only masculine for now: the prompt says most leads are men and to default to the masculine. When
 * Phase 4 knows the lead's gender from the CRM, this takes a parameter and the feminine forms
 * (שלך -> "שלאך", לך -> "לאך") get their own table.
 */
export function forceMasculineAddress(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECOND_PERSON_MASCULINE) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** The prompt's silence token. Nothing downstream interprets it, so it must never reach the TTS. */
const NO_RESPONSE = /NO_RESPONSE_NEEDED/gi;

/**
 * Hebrew niqqud + cantillation marks (U+0591–U+05C7 — the same range stripped in
 * normalizeFillerWord). Cartesia mispronounces vowel-pointed Hebrew — Koren confirmed the
 * inconsistency persisted with niqqud in the prompt (see the gender note above). So if the model
 * ever emits niqqud, strip it before the text reaches the TTS; bare consonantal Hebrew is what
 * Cartesia reads most reliably. Speech-only, like forceMasculineAddress — never touches what is
 * stored, logged or transcribed.
 */
const NIQQUD = /[֑-ׇ]/gu;

/** Removes Hebrew niqqud / cantillation so the TTS receives clean consonantal text. */
export function stripNiqqud(text: string): string {
  return text.replace(NIQQUD, '');
}

/**
 * Claims that a booking is DONE. Every one of these is a lie — UNTIL a booking actually happened.
 *
 * Phase 4 made the claim conditionally true: when the tenant's tool gate is open and book_meeting
 * SUCCEEDED on this call, `allowBookingClaims` flips (via ToolRuntimeContext.bookingCompleted) and
 * these sentences pass through untouched, because they are now the truth. Before that moment —
 * including on every tools-enabled call where the booking hasn't happened YET — the rewrite stays
 * armed. She cannot claim a booking she hasn't made, tools or no tools.
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
export async function* guardStream(
  input: AsyncIterable<string>,
  /**
   * Evaluated PER SENTENCE, not captured once: book_meeting succeeds mid-reply, and the very next
   * sentence ("קבעתי לך ליום ראשון...") must already be allowed through.
   */
  allowBookingClaims: () => boolean = () => false,
): AsyncIterable<string> {
  let buffer = '';

  const flush = function* (chunk: string): Generator<string> {
    const guarded = guardSpeech(chunk, { allowBookingClaims: allowBookingClaims() });
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
 * Stopwatch on one reply's trip through the speech path.
 *
 * WHY THIS EXISTS. Dead air is `end-of-turn + <something> + TTS first byte`, and we could not say
 * what `<something>` was. On the 2026-08-16 call a SHORT reply started speaking 218ms after the
 * LLM's first token — correct streaming — while a LONG one took 1416ms, as if it had waited for
 * the whole generation. Both went through this exact code. Two deploys were spent guessing between
 * "the guard buffers" and "the SDK buffers"; this settles it by measuring both ends.
 *
 * `firstIn` is the LLM's first token reaching us. `firstOut` is the first text we hand the TTS.
 * If they are close the guard is innocent and the delay is downstream; if `firstOut` lags, our
 * sentence buffering is the cost and the fix is here.
 */
/**
 * Lets the injected acknowledgement through immediately, then removes the model's echo of it.
 *
 * The acknowledgement ("אוקיי.") is enqueued by `llmNode` before the model has written anything,
 * so by the time the model opens with "אוקיי, בהחלט" the caller has ALREADY heard our version and
 * we cannot take it back. The old prepended filler could peek the opener and decline to speak;
 * this one cannot, so the duplicate is removed from the model's side instead.
 *
 * THE ACK IS YIELDED BEFORE ANY BUFFERING. That ordering is the entire feature — holding it even
 * briefly to inspect what follows would give back the ~1s this exists to win. Only the model's
 * first word is buffered, and only after the acknowledgement is already on its way to Cartesia,
 * where the wait is free.
 *
 * THE FIRST VERSION MATCHED `buffer.startsWith(ack + ' ')` AND THAT WAS EXACTLY WRONG. Text is
 * re-chunked between `llmNode` and `ttsNode`, so the "אוקיי. " that was injected arrives here as
 * "אוקיי." — the match failed, and the function then sat in its own loop waiting for 60 characters
 * of model text before emitting anything. On the 2026-08-17 call that held the acknowledgement for
 * 743–1944ms per turn (`latency audio_path heldMs=`): it was released at the same moment as the
 * reply it was supposed to precede, so it bought zero latency and merely added a word. The whole
 * <1s mechanism was defeated by one trailing space.
 *
 * Two rules follow, and both are load-bearing:
 *   1. Compare with whitespace REMOVED — never depend on how the SDK chunked our own string.
 *   2. Never hold the first chunk. If it is not ours, it goes out as-is; there is no text worth
 *      inspecting at the price of the caller's first audio.
 */
export async function* dropAckEcho(
  ack: string | null,
  stream: AsyncIterable<string>,
): AsyncIterable<string> {
  if (!ack) {
    yield* stream;
    return;
  }

  const wordBoundary = /[\s.,!?…׃]/u;
  const iterator = stream[Symbol.asyncIterator]();

  // Rule 1: whitespace-insensitive. `compact('אוקיי. ') === compact('אוקיי.')`.
  const compact = (s: string) => s.replace(/\s+/gu, '');
  const ackKey = compact(ack);

  // Our own string can also arrive SPLIT ("או" + "קיי."). Keep pulling only while what we have is
  // still a strict prefix of it — those chunks are already in flight, so this costs nothing, and
  // the moment the text diverges we stop. Never a wait on text the model has not written yet.
  let opening = '';
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      if (opening) yield opening;
      return;
    }
    opening += String(next.value);
    const seen = compact(opening);
    if (seen.length >= ackKey.length || !ackKey.startsWith(seen)) break;
  }

  if (!compact(opening).startsWith(ackKey)) {
    // Rule 2: not our injection — get out of the way rather than inspect it.
    yield opening;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  yield `${ack} `; // out the door first, always

  // Everything after the acknowledgement inside that same chunk, found by counting non-space
  // characters rather than by slicing a length that assumed a particular spacing.
  let consumed = 0;
  let cut = 0;
  for (const ch of opening) {
    if (consumed >= ackKey.length) break;
    if (!/\s/u.test(ch)) consumed += 1;
    cut += ch.length;
  }
  // `${ack} ` already carried the separating space; whatever spacing the chunk used is redundant.
  let buffer = opening.slice(cut).replace(/^\s+/u, '');
  let done = false;

  // Now — and only now, with the acknowledgement already on its way to Cartesia — buffer the
  // model's first word so an echoed opener can be removed. Bounded, because this wait is free
  // only for as long as it stays short.
  while (buffer.length <= 40 && !wordBoundary.test(buffer)) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    buffer += next.value;
  }

  const cleaned = dropEchoedOpener(ack, buffer);
  if (cleaned) yield cleaned;

  if (!done) {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  }
}

/**
 * Wraps a text stream and reports when its first non-empty chunk arrived, relative to `startedAt`.
 *
 * Deliberately a passthrough with a counter rather than anything cleverer: instrumentation that
 * changes the timing it is measuring is worse than none.
 */
export async function* timeFirstChunk(
  stream: AsyncIterable<string>,
  startedAt: number,
  onFirst: (elapsedMs: number) => void,
): AsyncIterable<string> {
  let seen = false;
  for await (const chunk of stream) {
    if (!seen && chunk.trim()) {
      seen = true;
      onFirst(Date.now() - startedAt);
    }
    yield chunk;
  }
}

/**
 * Passes a reply through untouched, and reports when it carried no speech at all.
 *
 * Wraps the guard's OUTPUT, not the model's. The question is not "did the model write something"
 * but "will the caller hear anything", and only what comes out of `guardStream` answers that: a
 * reply that was nothing but a `NO_RESPONSE_NEEDED` control token arrives here as zero chunks.
 *
 * That deliberate silence is a real feature — the caller asked her to hold — but it has no exit of
 * its own, and on 2026-08-16 it ran for twenty seconds of a live call before the caller asked
 * whether anyone was still there. This is how the agent finds out it happened.
 */
export async function* notifyIfSilent(
  stream: AsyncIterable<string>,
  onSilent: () => void,
): AsyncIterable<string> {
  let spoke = false;
  for await (const chunk of stream) {
    if (chunk.trim()) spoke = true;
    yield chunk;
  }
  if (!spoke) onSilent();
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
export function guardSpeech(
  text: string,
  opts: { allowBookingClaims?: boolean } = {},
): GuardResult {
  const interventions: string[] = [];
  let out = text;

  if (NO_RESPONSE.test(out)) {
    interventions.push('removed NO_RESPONSE_NEEDED (silence control token)');
    out = out.replace(NO_RESPONSE, '').trim();
    // If that was the WHOLE reply, she is meant to stay silent — which is the correct behaviour when
    // a caller says "רגע" or "שנייה". Saying nothing is the point.
    if (out === '') return { text: '', silent: true, interventions };
  }

  // Skipped ONLY when a real booking succeeded on this call (ToolRuntimeContext.bookingCompleted)
  // — at that point "קבעתי לך" is the truth and rewriting it would be the lie.
  if (!opts.allowBookingClaims) {
    for (const pattern of FALSE_BOOKING) {
      if (pattern.test(out)) {
        interventions.push(`rewrote a false booking claim: "${out.match(pattern)?.[0]?.slice(0, 50)}"`);
        out = out.replace(pattern, TRUTH);
      }
    }
  }

  // LAST, so it applies to the rewritten text too. Purely a PRONUNCIATION fix — it changes how
  // Cartesia says the word, never which word the LLM chose. See forceMasculineAddress().
  out = forceMasculineAddress(out);

  // Strip any niqqud the model emitted — Cartesia mispronounces vowel-pointed Hebrew. Only logs an
  // intervention when it actually removed something, so it stays quiet on the common (unpointed) case.
  const unpointed = stripNiqqud(out);
  if (unpointed !== out) {
    interventions.push('stripped niqqud (Cartesia mispronounces vowel points)');
    out = unpointed;
  }

  return { text: out.replace(/\s{2,}/gu, ' ').trim(), silent: false, interventions };
}

/**
 * Puts the hesitation at the very FRONT of the reply, then gets out of the way.
 *
 * This exists because the first version SPOKE the filler with session.say(), and say() QUEUES —
 * so it played after whatever she was already saying, landing at the END of her turn. Koren:
 * "היא עושה קולות של חשיבה אחרי שהיא מסיימת לדבר, זה לא תקין." A person who hesitates after
 * finishing their sentence is not thinking; it is a twitch.
 *
 * Prepending makes correct placement structural rather than a matter of timing luck: the hesitation
 * is the first sound of her next breath, and it cannot be anywhere else.
 */
export async function* withFiller(
  filler: string | null,
  text: AsyncIterable<string>,
): AsyncIterable<string> {
  if (!filler) {
    yield* text;
    return;
  }

  // COLLISION GUARD. The filler ends in "..." — a sentence terminator — so guardStream flushes it as
  // its OWN TTS chunk. If the reply's SHORT opener starts with the same word (e.g. filler "רגע..."
  // and the prompt's opener example "רגע, בודקת."), the caller hears that word TWICE back-to-back.
  // Koren heard exactly this. So peek the reply's first word before committing the filler, and drop
  // the filler when the opener is about to repeat it. We buffer only up to the first word boundary —
  // a few characters — so the fast-filler benefit is essentially unchanged.
  const fillerWord = normalizeFillerWord(filler);
  const iterator = text[Symbol.asyncIterator]();
  const wordBoundary = /[\s.,!?…׃]/u;
  let buffer = '';
  let streamDone = false;
  while (buffer.length <= 40) {
    const next = await iterator.next();
    if (next.done) {
      streamDone = true;
      break;
    }
    buffer += next.value;
    if (wordBoundary.test(buffer)) break;
  }

  const firstWord = buffer.split(wordBoundary)[0] ?? '';
  const collides = firstWord.length > 0 && normalizeFillerWord(firstWord) === fillerWord;
  if (!collides) yield `${filler} `;

  if (buffer) yield buffer;
  if (!streamDone) {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  }
}

/** Bare comparison key for a filler/opener word: drop trailing ellipsis + punctuation and Hebrew
 * niqqud, so "רגע..." and an opener "רגע," match. */
function normalizeFillerWord(s: string): string {
  return s
    .replace(/[֑-ׇ]/gu, '') // niqqud / cantillation
    .replace(/[\s.,!?…׃]+/gu, '')
    .toLowerCase();
}
