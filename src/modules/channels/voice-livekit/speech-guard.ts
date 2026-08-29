import { dropEchoedOpener } from './prompts/acknowledgements.he.js';
import { normalizeSpokenNumbers } from './speech-numbers.he.js';

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
 * WHAT DID NOT WORK: FULL niqqud (שֶׁלְּךָ) — pointing every syllable. Cartesia still mispronounced
 * with it in the prompt, and fully-pointed sentences came out distorted and 1.3–2.4× longer
 * (tests/hebrew-tts-niqqud-ab, docs/phase-4-known-issues.md §13). The FIRST shipped fix respelled
 * the suffix phonetically ("שלכה") — it worked, and it lost the round-3 listening A/B.
 *
 * WHAT WON, by Koren's ear on sonic-3.5 (round 3, 2026-08-26): ONE vowel mark on the ambiguous
 * letter only — שלךָ, a kamatz on the final kaf, the rest of the sentence untouched. A little
 * niqqud is not a little of the full-niqqud problem: one mark on one letter answers exactly the
 * question the TTS was guessing at, without pushing the whole sentence out of its training
 * distribution. The feminine table (round 3 + 3b) mixes techniques per word — each entry is
 * whatever won by ear, respelling or single mark; no entry is derived from theory.
 *
 * VERIFIED, not assumed — the same round-trip as the original שלכה fix, for EVERY entry below:
 * synthesized, squeezed through an 8kHz phone line, transcribed back with Soniox
 * (tests/hebrew-tts-niqqud-ab/roundtrip.ts, 27 clips):
 *
 *     sent:  מה כתובת המייל שלךָ?
 *     heard: מה כתובת המייל שלך?     <- the intended plain Hebrew word, in the masculine
 *
 * The marked spelling is non-standard and NOBODY EVER SEES IT — it exists for exactly the few
 * milliseconds between the LLM and the speaker.
 *
 * AND THIS IS WHY IT IS DONE HERE AND NOT IN THE PROMPT. The first attempt BANNED these words in
 * the system prompt, with a table of replacements. Koren, immediately: "אל תגדיר אותם כמילים
 * אסורות, זה לא פתרון." He is right. Crippling her vocabulary to work around a pronunciation bug
 * makes her speak like a foreigner. She writes natural Hebrew; the pipeline fixes the sound.
 */
export type AddressGender = 'm' | 'f';

const SECOND_PERSON_MASCULINE: Array<[RegExp, string]> = [
  // Lookarounds, not \b — Hebrew letters are not word characters in JS regex, so \b matches in the
  // MIDDLE of a Hebrew word and would corrupt "משלך", "הלך", "שלכם". The lookahead also covers
  // niqqud (U+0590–U+05FF), which makes every rule idempotent: לךָ no longer matches לך.
  //
  // NOT one technique per table — one WINNER per word. The kamatz won rounds 3/3b for the first
  // four (m1/m2/bm1/bm2 = C). For איתך/בשבילך/עבורך Koren rejected both plain AND kamatz (3b),
  // then round 3c scored the כה respelling against a patach mark — the respelling won all three
  // (c1/c2/c3 = B, 2026-08-26). So the split below is final, each row by ear, not by theory.
  [/(?<![֐-׿])שלך(?![֐-׿])/gu, 'שלךָ'],
  [/(?<![֐-׿])לך(?![֐-׿])/gu, 'לךָ'],
  [/(?<![֐-׿])אותך(?![֐-׿])/gu, 'אותךָ'],
  [/(?<![֐-׿])אליך(?![֐-׿])/gu, 'אליךָ'],
  [/(?<![֐-׿])איתך(?![֐-׿])/gu, 'איתכה'],
  [/(?<![֐-׿])בשבילך(?![֐-׿])/gu, 'בשבילכה'],
  [/(?<![֐-׿])עבורך(?![֐-׿])/gu, 'עבורכה'],
  // רוצה — rotsE (m) / rotsA (f), same letters (added on Koren's report, 2026-08-26 evening).
  // The gender of רוצה follows its SUBJECT, not the addressee — so this rule deliberately skips
  // "אני רוצה" (the agent, about herself), "הוא/היא/מי רוצה" (third persons): those get fixed
  // subject-side in PRONUNCIATION_FIXES. What is left — "אתה רוצה", "רוצה לשמוע עוד?" — is
  // second person, and follows the addressee. "מרוצה" is protected by the letter lookbehind.
  [/(?<!(?:אני|היא|הוא|מי)\s(?:לא\s)?)(?<![֐-׿])רוצה(?![֐-׿])/gu, 'רוצֶה'],
];

/**
 * The feminine table — same words, addressed to a woman. Per-word winners from Koren's rounds
 * 3/3b verdicts (f1=C, f2=B, bf1=B, bf2=C, bf3=B, bf4=C, bf5=C): a MIX of the אך-respelling and
 * minimal niqqud — whichever won by ear for that word, nothing derived from theory. Note bf2's
 * winner is the fully-pointed אלַיִךְ (three marks) — "minimal" means as few marks as THAT WORD
 * needs, not one mark everywhere.
 */
const SECOND_PERSON_FEMININE: Array<[RegExp, string]> = [
  [/(?<![֐-׿])שלך(?![֐-׿])/gu, 'שלאך'],
  [/(?<![֐-׿])לך(?![֐-׿])/gu, 'לָךְ'],
  [/(?<![֐-׿])אותך(?![֐-׿])/gu, 'אותאך'],
  [/(?<![֐-׿])אליך(?![֐-׿])/gu, 'אלַיִךְ'],
  [/(?<![֐-׿])איתך(?![֐-׿])/gu, 'איתאך'],
  [/(?<![֐-׿])בשבילך(?![֐-׿])/gu, 'בשבילֵךְ'],
  [/(?<![֐-׿])עבורך(?![֐-׿])/gu, 'עבורֵךְ'],
  // רוצה, feminine addressee — see the masculine table's note on why אני/הוא/היא are skipped.
  [/(?<!(?:אני|היא|הוא|מי)\s(?:לא\s)?)(?<![֐-׿])רוצה(?![֐-׿])/gu, 'רוצָה'],
];

/**
 * Gender-NEUTRAL pronunciation fixes — words sonic-3.5 misreads for everyone, regardless of who
 * is being addressed. The living pronunciation dictionary: one entry per word, each verified the
 * same way (listening page win + Soniox round-trip) before it lands. Same lookaround rules as the
 * gender tables.
 */
const PRONUNCIATION_FIXES: Array<[RegExp, string]> = [
  // לוודא: the final-aleph vowel gets dropped ("levad"). One tsere on the ד restores "levadé".
  // Round-3 winner (vd1+vd2 = C) over the לוודה respelling; round-trips as לוודא. 2026-08-26.
  [/(?<![֐-׿])לוודא(?![֐-׿])/gu, 'לוודֵא'],
  // רוצה with an explicit SUBJECT — gender comes from the subject, never from the addressee
  // (the addressee-driven cases live in the gender tables). "אני רוצה" is the AGENT speaking:
  // feminine because the persona (Keren) is feminine — when tenant `agent_persona` ships, this
  // is the line that takes its gender from it.
  [/(?<![֐-׿])((?:ו|ש|וש|כש|וכש)?אני(?:\s+לא)?)\s+רוצה(?![֐-׿])/gu, '$1 רוצָה'],
  [/(?<![֐-׿])((?:ו|ש|וש|כש|וכש)?היא(?:\s+לא)?)\s+רוצה(?![֐-׿])/gu, '$1 רוצָה'],
  [/(?<![֐-׿])((?:ו|ש|וש|כש|וכש)?הוא(?:\s+לא)?)\s+רוצה(?![֐-׿])/gu, '$1 רוצֶה'],
];

/** Applies the gender-neutral pronunciation dictionary. Speech-only, like the gender fix. */
export function applyPronunciationFixes(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PRONUNCIATION_FIXES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Forces the 2nd-person pronouns to be PRONOUNCED in the given gender, without changing a word the
 * LLM chose. Applied to what Cartesia is asked to say — never to what is stored, logged or
 * transcribed. The gender comes from AddressGenderTracker (masculine until proven feminine).
 */
export function forceAddressGender(text: string, gender: AddressGender = 'm'): string {
  const table = gender === 'f' ? SECOND_PERSON_FEMININE : SECOND_PERSON_MASCULINE;
  let out = text;
  for (const [pattern, replacement] of table) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** The pre-round-3 name, kept for its history in comments and reports: masculine-table shorthand. */
export function forceMasculineAddress(text: string): string {
  return forceAddressGender(text, 'm');
}

/** Optional attached prefixes before a marker word: ולך, שאת, כשתרצי, וכשבוא… */
const PFX = '(?:ו|ש|וש|כש|וכש|לכש)?';

/**
 * Unambiguously-feminine ADDRESS in the agent's own Hebrew. Three shapes:
 *
 *   1. 2nd-person-feminine verbs (תרצי, תוכלי, בואי, ספרי…) — the ת…י future and the ־י
 *      imperative belong to nobody else in the paradigm. A curated list, not a clever pattern:
 *      ת…י as a REGEX would also match nouns and possessives. The 2026-08-26 test call showed the
 *      cost of a THIN list, though — the LLM switched with בואי/תראי/תאבדי, none of which were
 *      listed, and the flip came a full reply late. The list is now the agent's actual sales
 *      vocabulary; extend it whenever a transcript shows a missed form.
 *   2. את + a present-tense verb — "את רוצה", "מה שאת רוצה". The subject pronoun את is itself
 *      feminine; requiring the following verb keeps the object-marker homograph ("את הפרטים")
 *      from matching. Prefixes allowed: the real call said "מה שאת רוצה" and the un-prefixed
 *      pattern missed it.
 *   3. An explicit promise — "אדבר בלשון נקבה". When she SAYS which register she is using,
 *      believe her.
 */
const FEMININE_ADDRESS = new RegExp(
  `(?<![֐-׿])${PFX}(?:` +
    [
      'תרצי', 'תוכלי', 'תגידי', 'תדעי', 'תעדיפי', 'תחליטי', 'תחשבי', 'תשלחי',
      'תקבלי', 'תאשרי', 'תבדקי', 'תחזרי', 'תספרי', 'תצטרכי', 'תשמחי',
      'תראי', 'תעשי', 'תהיי', 'תדברי', 'תעני', 'תבחרי', 'תמצאי', 'תתחילי',
      'תמשיכי', 'תפני', 'תצליחי', 'תסכימי', 'תזכרי', 'תתקשרי', 'תכתבי',
      'תקראי', 'תאבדי', 'בואי', 'ספרי', 'תני',
    ].join('|') +
    ')(?![֐-׿])' +
    `|(?<![֐-׿])${PFX}את\\s+(?:רוצה|יכולה|צריכה|מעוניינת|פנויה|זמינה|מחפשת|נמצאת|מעדיפה|חושבת|מכירה)(?![֐-׿])` +
    '|לשון\\s+נקבה',
  'gu',
);

/**
 * Unambiguously-masculine ADDRESS. Deliberately much shorter than the feminine list: the
 * masculine future (תרצה, תוכל) is spelled identically to 3rd-person feminine ("היא תוכל
 * לעזור"), so listing ANY of it would misfire on a sentence about the agent herself. What is
 * safe: the pronoun אתה, the imperative בוא, אדוני, and the explicit "לשון זכר" promise.
 */
const MASCULINE_ADDRESS = new RegExp(
  `(?<![֐-׿])${PFX}(?:אתה|בוא|אדוני)(?![֐-׿])|לשון\\s+זכר`,
  'gu',
);

/** The CALLER saying outright which they are. The strongest evidence there is. */
const USER_SAYS_FEMININE = /לשון\s+נקבה|אני\s+(?:אישה|בחורה|נקבה)/u;
const USER_SAYS_MASCULINE = /לשון\s+זכר|אני\s+(?:גבר|בחור|זכר)/u;

/**
 * Decides which gender table the pronunciation fix uses — from the conversation itself.
 *
 * Only the conversation knows the lead's gender; no TTS can hear it in a suffix pronoun. Two
 * sources feed it:
 *
 *   - observe(): the LLM's OWN conjugation ("תרצי" vs "אתה"), per the prompt's gender rules.
 *   - observeUser(): the caller saying it outright ("אני אישה", "אפשר בלשון זכר") — fed from the
 *     ConversationItemAdded hook, so the flip happens BEFORE the LLM's next reply instead of one
 *     reply late.
 *
 * LATEST SIGNAL WINS, in both directions. The first version was one-way (masc→fem, sticky) and
 * the 2026-08-26 test call showed exactly why that is wrong: the caller switched their requested
 * register mid-call, the LLM followed ("אני אדבר בלשון זכר"), and the sticky table kept forcing
 * לָךְ — "שוב, אותה טעות". Within one sentence carrying both kinds of evidence, the later match
 * wins. Masculine remains the default (Koren's rule: names are unreliable). One tracker per
 * call; a new call starts masculine again.
 */
export class AddressGenderTracker {
  private gender: AddressGender = 'm';

  get current(): AddressGender {
    return this.gender;
  }

  /** Feeds one of HER outgoing sentences. Returns the new gender when it changed, else null. */
  observe(sentence: string): AddressGender | null {
    return this.apply(lastMatchGender(sentence, FEMININE_ADDRESS, MASCULINE_ADDRESS));
  }

  /** Feeds one committed CALLER utterance. Returns the new gender when it changed, else null. */
  observeUser(utterance: string): AddressGender | null {
    const fem = USER_SAYS_FEMININE.test(utterance);
    const masc = USER_SAYS_MASCULINE.test(utterance);
    // Both in one utterance ("לא לשון נקבה, לשון זכר") is genuinely ambiguous to a regex — the
    // agent-side evidence on the next reply settles it. Act only on a clear single signal.
    if (fem === masc) return this.apply(null);
    return this.apply(fem ? 'f' : 'm');
  }

  private apply(evidence: AddressGender | null): AddressGender | null {
    if (evidence === null || evidence === this.gender) return null;
    this.gender = evidence;
    return evidence;
  }
}

/** The gender of the LAST unambiguous marker in the sentence, or null when there is none. */
function lastMatchGender(sentence: string, fem: RegExp, masc: RegExp): AddressGender | null {
  let lastFem = -1;
  let lastMasc = -1;
  for (const m of sentence.matchAll(fem)) lastFem = m.index;
  for (const m of sentence.matchAll(masc)) lastMasc = m.index;
  if (lastFem === -1 && lastMasc === -1) return null;
  return lastFem > lastMasc ? 'f' : 'm';
}

/** The prompt's silence token. Nothing downstream interprets it, so it must never reach the TTS. */
const NO_RESPONSE = /NO_RESPONSE_NEEDED/gi;

/**
 * Hebrew niqqud + cantillation marks (U+0591–U+05C7 — the same range stripped in
 * normalizeFillerWord). MODEL-emitted niqqud is unreliable on Cartesia — full pointing came out
 * distorted (known-issues §13), and the model points words we never verified. So anything the LLM
 * pointed is stripped before the text reaches the TTS. The VERIFIED single marks this file injects
 * (round 3 — see the gender note above) are the one exception, which is purely an ordering rule:
 * guardSpeech strips FIRST, then applies the tables. Reversing that order silently erases every
 * pronunciation fix — there is a test pinning it. Speech-only, like the tables — never touches
 * what is stored, logged or transcribed.
 */
const NIQQUD = /[֑-ׇ]/gu;

/** Removes Hebrew niqqud / cantillation so only THIS FILE's verified marks reach the TTS. */
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
  /**
   * One per call (lives on the agent instance). Observes each sentence BEFORE it is fixed, so the
   * sentence that reveals the lead is a woman ("תוכלי לשלוח לך...") already gets the feminine
   * table. Omitted (tests, legacy callers) → masculine, the pre-round-3 behaviour.
   */
  genderTracker?: AddressGenderTracker,
  /**
   * VOICE_SPEECH_NUMBERS_ENABLED — digits become colloquial Hebrew words before the TTS.
   * Default false here (tests, legacy callers keep digit behaviour); the agent threads the env
   * flag in, same pattern as allowBookingClaims.
   */
  spokenNumbers = false,
): AsyncIterable<string> {
  let buffer = '';

  const flush = function* (chunk: string): Generator<string> {
    const flipped = genderTracker?.observe(chunk);
    if (flipped) {
      console.log(
        `speech_guard ${JSON.stringify({ note: `address gender -> ${flipped === 'f' ? 'feminine' : 'masculine'} (unambiguous conjugation in her own reply)` })}`,
      );
    }
    const guarded = guardSpeech(chunk, {
      allowBookingClaims: allowBookingClaims(),
      addressGender: genderTracker?.current,
      spokenNumbers,
    });
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
  opts: {
    allowBookingClaims?: boolean;
    addressGender?: AddressGender;
    /** Digits → colloquial Hebrew words (times, phones, prices). See speech-numbers.he.ts. */
    spokenNumbers?: boolean;
  } = {},
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

  // Digits → colloquial Hebrew words (clock times, phone read-outs, round prices). Speech-only,
  // like everything in this file — the transcript keeps the digits. Runs BEFORE the niqqud strip
  // and the tables, so a future pronunciation-dictionary entry applies to number words too; the
  // position is pinned by a test. Kill-switch: VOICE_SPEECH_NUMBERS_ENABLED.
  if (opts.spokenNumbers) {
    const spoken = normalizeSpokenNumbers(out);
    if (spoken !== out) {
      interventions.push('spoke digits as Hebrew words (time/phone/price)');
      out = spoken;
    }
  }

  // Strip any niqqud the MODEL emitted — unverified pointing is unreliable on Cartesia. MUST run
  // BEFORE the fixes below, which inject this file's own verified marks; reversed, it erases them.
  // Only logs when it actually removed something, so it stays quiet on the common (unpointed) case.
  const unpointed = stripNiqqud(out);
  if (unpointed !== out) {
    interventions.push('stripped model-emitted niqqud (unverified pointing is unreliable on Cartesia)');
    out = unpointed;
  }

  // LAST, so they apply to the rewritten text too. Purely PRONUNCIATION fixes — they change how
  // Cartesia says the word, never which word the LLM chose. See forceAddressGender().
  out = forceAddressGender(out, opts.addressGender ?? 'm');
  out = applyPronunciationFixes(out);

  return { text: out.replace(/\s{2,}/gu, ' ').trim(), silent: false, interventions };
}

/**
 * Puts the hesitation immediately in FRONT OF HER FIRST REAL WORDS — and drops it when there are none.
 *
 * This exists because the first version SPOKE the filler with session.say(), and say() QUEUES —
 * so it played after whatever she was already saying, landing at the END of her turn. Koren:
 * "היא עושה קולות של חשיבה אחרי שהיא מסיימת לדבר, זה לא תקין." A person who hesitates after
 * finishing their sentence is not thinking; it is a twitch.
 *
 * THE 2026-08-29 CALL ADDED THE SECOND HALF OF THE RULE: a hesitation is only honest if the answer
 * is right behind it. `ttsNode` runs on the first text chunk of an inference STEP, and a step whose
 * only real output is a tool call carries no reply at all — so prepending there produced a word
 * followed by five seconds of silence, which is worse than no filler. Koren heard exactly that and
 * called it a script.
 *
 * So the filler is now held until the model's first real words are IN HAND, and if they never come
 * it is never spoken (`onUsed` is not called, and the call's budget is not spent). The wait costs
 * nothing that matters: `leadIn` — the acknowledgement `llmNode` injects — is passed straight
 * through untouched, so the <1s first-audio path is exactly as it was.
 */
export async function* withFiller(
  filler: string | null,
  text: AsyncIterable<string>,
  opts: {
    /** The acknowledgement already on its way to the TTS ahead of the model's words, if any.
     * Yielded immediately, never held, and never counted as the model's first word. */
    leadIn?: string | null;
    /** Called only when the hesitation actually reaches the TTS. */
    onUsed?: () => void;
  } = {},
): AsyncIterable<string> {
  if (!filler) {
    yield* text;
    return;
  }

  const fillerWord = normalizeFillerWord(filler);
  const iterator = text[Symbol.asyncIterator]();
  const wordBoundary = /[\s.,!?…׃]/u;
  let buffer = '';
  let streamDone = false;

  // THE ACKNOWLEDGEMENT GOES OUT UNTOUCHED, FIRST, ALWAYS. Holding it even briefly would give back
  // the ~1s that instant-ack exists to win (see dropAckEcho — the same lesson, learned the hard way
  // on the 2026-08-17 call). Whatever the chunk carries BEYOND the acknowledgement is model text and
  // seeds the buffer below.
  const leadIn = opts.leadIn ?? null;
  if (leadIn) {
    const compact = (s: string) => s.replace(/\s+/gu, '');
    const leadInKey = compact(leadIn);
    const first = await iterator.next();
    if (first.done) return; // nothing was said at all — nothing to hesitate in front of
    const chunk = String(first.value);
    if (leadInKey.length > 0 && compact(chunk).startsWith(leadInKey)) {
      yield chunk;
      let consumed = 0;
      let cut = 0;
      for (const ch of chunk) {
        if (consumed >= leadInKey.length) break;
        if (!/\s/u.test(ch)) consumed += 1;
        cut += ch.length;
      }
      buffer = chunk.slice(cut).replace(/^\s+/u, '');
    } else {
      // Not our injection — it is already the model talking, so treat it as the first word.
      buffer = chunk;
    }
  }

  // COLLISION GUARD. The filler ends in "..." — a sentence terminator — so guardStream flushes it as
  // its OWN TTS chunk. If the reply's SHORT opener starts with the same word (e.g. filler "רגע..."
  // and the prompt's opener example "רגע, בודקת."), the caller hears that word TWICE back-to-back.
  // Koren heard exactly this. So peek the reply's first word before committing the filler, and drop
  // the filler when the opener is about to repeat it. We buffer only up to the first word boundary —
  // a few characters — so the fast-filler benefit is essentially unchanged.
  while (buffer.length <= 40 && !wordBoundary.test(buffer)) {
    const next = await iterator.next();
    if (next.done) {
      streamDone = true;
      break;
    }
    buffer += next.value;
  }

  // NO REAL WORDS = NO HESITATION. This is the tool-call step: the acknowledgement (if any) has
  // been spoken, the model wrote nothing else, and the next sentence is one tool round-trip and a
  // whole new inference away. A hesitation here is the orphaned word from the 2026-08-29 call.
  if (buffer.length === 0) return;

  const firstWord = buffer.split(wordBoundary)[0] ?? '';
  const collides = firstWord.length > 0 && normalizeFillerWord(firstWord) === fillerWord;
  if (!collides) {
    yield `${filler} `;
    opts.onUsed?.();
  }

  yield buffer;
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
