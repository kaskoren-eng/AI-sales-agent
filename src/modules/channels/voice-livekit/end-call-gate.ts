/**
 * THE 260-SECOND HANG-UP — the one decision on this call that cannot be taken back, in code.
 *
 * 2026-08-31 19:54, live PSTN, the fourth call of the day. The last twelve seconds, verbatim from
 * `call-reports/2026-08-31T19-54-51-237Z.json`:
 *
 *   [243.5-260.0s] KEREN  "...ובדמו אתה שומע את זה חי על שיחה אמיתית.
 *                          אם זה עדיין מרגיש לךָ לא נכון"          <- her own conditional, unfinished
 *   [259.2-259.7s] lead   "כן, מרגיש לך."                          <- spoken INSIDE her speech window
 *   [261.3-269.8s] KEREN  "הבנתי אותךָ. אז כנראה שזה לא הזמן הנכון. ... שיהיה יום נעים."
 *   [271.5s]       end_call(reason: "not_qualified")
 *
 * Nobody said it was the wrong time. She opened *"if it still feels wrong to you…"*, was cut off
 * mid-conditional, and then read a half-second fragment that echoed her own words back at her as
 * the affirmative answer to a question she never finished asking. Koren says he tried to stop her
 * and she carried on; only `כן.` reached the transcript before the hang-up.
 *
 * WHAT I ESTABLISHED, AND HOW.
 *
 *   1. `end_call` had NO gate of any kind in code. `endCallTool` took the model's `reason` and ran
 *      the teardown. The only thing standing between a lead and a hang-up was DISQUALIFY_GATE — a
 *      paragraph of prompt text added after the 79-second disqualification on the 16:51 call, which
 *      is the same defect nine hours earlier. A prompt rule that has already been overrun once is
 *      not the place to put the second attempt.
 *   2. The overlap is MEASURED, not inferred: the caller's line ran 259248-259693ms and hers ran
 *      243477-260013ms (`spokeAtMs`/`spokeUntilMs` on the committed messages, the SDK's own clock).
 *      His entire turn happened while she was still talking. `speech_final` on an overlap is
 *      precisely where STT garbage lives, and this one was garbage: `מרגיש לך` is the tail of HER
 *      sentence with the `לא` dropped — the negation-safety failure this repo already ships a rule
 *      for, this time applied to her own outgoing speech.
 *   3. She had already judged him. `capture_lead_info` at 175.7s recorded `qualification: "hot"`.
 *      Ninety-six seconds later the same model called him `not_qualified`. Nothing he said in
 *      between was a decline.
 *
 * SO THE GATE ASKS THREE QUESTIONS, and it is deliberately NOT a second copy of DISQUALIFY_GATE.
 * The prompt tells her when disqualifying is a good idea; this refuses to execute one that rests on
 * something the caller did not clearly say:
 *
 *   - Did his last turn OVERLAP her speech? Then it is not evidence of anything.
 *   - Is it merely an ECHO of her own last words? Then it is not his sentence.
 *   - Did he actually DECLINE, in words? If not, she must ASK before she hangs up.
 *
 * WHAT IT DOES NOT TOUCH. `opt_out` is a legal instruction and fires immediately, every time —
 * Israeli spam law does not wait for a confirmation round-trip, and a caller who says "take me off
 * your list" must never be asked to say it twice. `meeting_booked`, `bad_time`,
 * `callback_requested` and `wrong_person` all end a call the caller is choosing to end. Only the
 * two reasons that mean WE decided he is not worth the rest of the call are gated.
 *
 * FAIL-SAFE IN THE DIRECTION OF STAYING ON THE LINE, and capped so it can never trap anyone: after
 * `MAX_REFUSALS` the gate stops refusing. A caller who genuinely wants off the phone gets off it.
 *
 * Pure — no clock, no I/O, no SDK types — so the 260-second sequence is a unit test.
 * Kill-switch: VOICE_END_CALL_CONFIRM_ENABLED (default on) restores the ungated 2026-08-31 tool.
 */

/**
 * The reasons that mean "we decided this lead is gone" rather than "the caller ended it".
 *
 * `other` is deliberately NOT here. It is the model's escape hatch for a call that ended for a
 * reason the enum does not name, and refusing those would turn every unusual ending into a loop.
 */
export const DISQUALIFYING_END_REASONS = ['not_qualified', 'not_interested'] as const;

export type DisqualifyingEndReason = (typeof DISQUALIFYING_END_REASONS)[number];

export function isDisqualifyingEndReason(reason: string): reason is DisqualifyingEndReason {
  return (DISQUALIFYING_END_REASONS as readonly string[]).includes(reason);
}

/**
 * How many times the gate may refuse one call before it gets out of the way.
 *
 * Two, not one: the first refusal buys the confirmation question, and the second covers the case
 * where the caller talks over that question too. A third would be the agent arguing with a man who
 * wants to hang up.
 */
export const MAX_REFUSALS = 2;

/**
 * An UNAMBIGUOUS decline, said by the lead in his own words.
 *
 * Every entry is a whole clause a Hebrew speaker uses to end a sales call, not a word that merely
 * leans negative. `לא` on its own is NOT here and must never be: "לא" answers whatever she asked,
 * and on this call what she asked was an unfinished conditional. Nor is `לא יודע` — the caller said
 * exactly that at 241s while continuing to engage for another twenty seconds.
 *
 * Anchored on the verb, so prefixes and suffixes ("אני ממש לא מעוניין", "לא מעוניינת") still match.
 */
const EXPLICIT_DECLINE: RegExp[] = [
  /לא\s+מעוני/u, // "לא מעוניין" / "לא מעוניינת" — stops before the final nun, which is a different letter
  /לא\s+רלוונטי/u,
  /לא\s+מתאים\s+לי/u,
  /לא\s+בא\s+לי/u,
  /לא\s+רוצה\s+(?:להמשיך|לשמוע|דמו|שיחה)/u,
  /(?:תודה|טוב),?\s*לא/u, // "תודה, לא"
  /(?:בוא\s+)?נסיים(?:\s+כאן|\s+פה)?/u,
  /(?:אני\s+)?(?:סוגר|מנתק|עוזב)(?:\s+את\s+השיחה)?/u,
  /(?:אל|לא)\s+תתקשר/u,
  /תורידו?\s+אותי\s+מהרשימה/u,
  /די,?\s*מספיק/u,
  /לא\s+מעניין\s+אותי/u,
];

/** He said it in English, which the prompt allows him to switch to at any point. */
const EXPLICIT_DECLINE_EN: RegExp[] = [
  /\bnot\s+interested\b/iu,
  /\bno\s*,?\s*thank(?:s| you)\b/iu,
  /\bstop\s+calling\b/iu,
  /\bhang\s+up\b/iu,
];

/** Does this caller turn say, unmistakably, that he is done? */
export function saysExplicitDecline(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return (
    EXPLICIT_DECLINE.some((p) => p.test(t)) || EXPLICIT_DECLINE_EN.some((p) => p.test(t))
  );
}

/** Hebrew niqqud / cantillation — stripped before comparison so `לךָ` and `לך` are one word. */
const MARKS = /[֑-ׇ]/gu;

/** Punctuation and the em-dash furniture Soniox sprinkles through a hesitant sentence. */
const NOISE = /[.,!?…׃"'׳״\-–—()]/gu;

function normalise(text: string): string {
  return text.replace(MARKS, '').replace(NOISE, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * Is the caller's turn just HER OWN last words handed back?
 *
 * `כן, מרגיש לך.` against `...אם זה עדיין מרגיש לךָ לא נכון` — strip the niqqud and the punctuation
 * and every content word of his turn appears, in order, at the tail of hers. That is not a man
 * agreeing with a proposition; it is a microphone hearing her through his handset, or an STT
 * hypothesis anchored on what it had just transcribed.
 *
 * DELIBERATELY CRUDE, and it does not need to be better. Its only consumer is the disqualifying
 * hang-up: a false YES costs one confirmation question, a false NO costs a lead. It compares
 * against the LAST 12 words of her turn, because an echo comes from the end of what she said, and
 * it requires at least two content words to fire so a bare "כן." can never be called an echo (it is
 * handled by the decline test, which correctly refuses to read "כן" as anything at all).
 */
export const ECHO_WINDOW_WORDS = 12;
export const ECHO_MIN_WORDS = 2;

/** Words that carry no meaning of their own, so their reappearance proves nothing. */
const ECHO_STOPWORDS = new Set([
  'כן',
  'לא',
  'אה',
  'אם',
  'זה',
  'את',
  'אני',
  'אתה',
  'של',
  'עוד',
  'גם',
  'הוא',
  'היא',
]);

export function echoesAgentTail(
  callerTurn: string | null | undefined,
  agentTurn: string | null | undefined,
): boolean {
  if (!callerTurn || !agentTurn) return false;
  const caller = normalise(callerTurn).split(' ').filter(Boolean);
  const content = caller.filter((w) => !ECHO_STOPWORDS.has(w));
  if (content.length < ECHO_MIN_WORDS) return false;
  const tail = normalise(agentTurn).split(' ').filter(Boolean).slice(-ECHO_WINDOW_WORDS);
  if (tail.length === 0) return false;
  const tailSet = new Set(tail);
  return content.every((w) => tailSet.has(w));
}

/**
 * The caller's last committed turn, as the gate needs to see it.
 *
 * `overlappedAgentSpeech` is the measurement the whole gate rests on and it is NOT a guess: it is
 * the SDK's own `startedSpeakingAt` for his message compared with `stoppedSpeakingAt` for hers.
 * Undefined (a call with no speaking metrics — console mode, a test, an interrupted reply with no
 * audio) reads as `false`, i.e. "no evidence of an overlap", because inventing one would refuse
 * hang-ups on every call that lacks the instrumentation.
 */
export interface LastCallerTurn {
  text: string;
  overlappedAgentSpeech: boolean;
  /** What she was saying when he spoke — the echo comparison's other half. */
  agentTurnBefore: string | null;
  /** Her sentence had no terminator: she was cut off mid-thought. See `unfinished` below. */
  agentTurnUnfinished: boolean;
}

export interface EndCallGateInput {
  reason: string;
  /** Null when the caller has not said anything yet — a hang-up on silence is a reflex, not this. */
  lastCallerTurn: LastCallerTurn | null;
  /** Has the gate already made her ask "shall I close this off for now?" on this call? */
  confirmationAsked: boolean;
  /** How many times the gate has already refused on this call. See MAX_REFUSALS. */
  refusals: number;
  /** What `capture_lead_info` last recorded — 'hot' / 'warm' / 'cold' / undefined. */
  recordedQualification?: string | undefined;
}

export type EndCallVerdict =
  | { allow: true }
  | {
      allow: false;
      /** One token, for the log and the call report. */
      code: 'overlapped_speech' | 'echoed_her_own_words' | 'no_explicit_decline';
      /** What the model is told INSTEAD of a goodbye. Speakable Hebrew is quoted inside it. */
      instruction: string;
    };

/**
 * The Hebrew she is told to say instead of hanging up.
 *
 * It is a QUESTION, and it names what she is proposing to do, so a man who did mean "no" can say so
 * in one word and a man who did not gets his call back. Koren has not heard this line: it is on
 * round 14 (`tests/hebrew-tts-niqqud-ab/round14.py`, card `c1`) and it is flagged in the handoff.
 */
export const END_CALL_CONFIRM_HE = 'אתה רוצה שנעצור כאן?';

/**
 * Should this `end_call` actually hang up?
 *
 * Reads as a list of reasons to STAY on the line, in the order that a person would think of them.
 * The default is `allow` — this gate exists to catch three specific ways of being wrong, not to
 * second-guess every ending.
 */
export function judgeEndCall(input: EndCallGateInput): EndCallVerdict {
  const { reason, lastCallerTurn, confirmationAsked, refusals, recordedQualification } = input;

  // Not our business: a booking, an opt-out, a bad time, a wrong number, or anything the model
  // could not name. Only the two "we decided he is gone" reasons pass below.
  if (!isDisqualifyingEndReason(reason)) return { allow: true };

  // Never trap a caller who wants off the phone.
  if (refusals >= MAX_REFUSALS) return { allow: true };

  // Nothing to judge. A call where the lead never spoke ends through the silence reflex, which sets
  // its own reason and does not come through this tool.
  if (lastCallerTurn === null) return { allow: true };

  const { text, overlappedAgentSpeech, agentTurnBefore, agentTurnUnfinished } = lastCallerTurn;
  const declined = saysExplicitDecline(text);

  // 1. HE TALKED OVER HER. Whatever the STT made of it, it is not a considered answer, and if her
  //    own sentence never finished it is not even an answer to a whole question.
  if (overlappedAgentSpeech && !declined) {
    return {
      allow: false,
      code: 'overlapped_speech',
      instruction: refuseInstruction(
        agentTurnUnfinished
          ? 'The caller spoke while you were still talking, and your own sentence never finished — ' +
              'so his words are not an answer to anything you actually asked.'
          : 'The caller spoke while you were still talking, so what was transcribed is not a ' +
              'considered answer.',
        recordedQualification,
      ),
    };
  }

  // 2. IT WAS HER OWN SENTENCE COMING BACK. This is what happened at 260s: `כן, מרגיש לך` is the
  //    tail of `אם זה עדיין מרגיש לךָ לא נכון` with the negation gone.
  if (!declined && echoesAgentTail(text, agentTurnBefore)) {
    return {
      allow: false,
      code: 'echoed_her_own_words',
      instruction: refuseInstruction(
        "The caller's last turn is an echo of your own previous sentence, not a statement of his " +
          'own — quite possibly your voice coming back down the line.',
        recordedQualification,
      ),
    };
  }

  // 3. HE NEVER SAID NO. Ending a call on an inference is the expensive half of the mistake; ending
  //    it on his own sentence is fine. Once she has ASKED and he has answered without an overlap,
  //    the answer stands even if it was not one of the fixed forms — he has been given a direct
  //    question and a chance to say what he wants.
  if (!declined && !confirmationAsked) {
    return {
      allow: false,
      code: 'no_explicit_decline',
      instruction: refuseInstruction(
        'The caller has not said he wants to stop. Ending the call here is your inference, not his ' +
          'decision.',
        recordedQualification,
      ),
    };
  }

  return { allow: true };
}

/**
 * What the model reads instead of `goodbyeInstruction`.
 *
 * It says the hang-up did NOT happen (a model that believes the call is ending writes a goodbye
 * either way), gives the one sentence to say, and forbids the farewell explicitly. The
 * qualification line is added only when her own tool call contradicts the ending she just asked
 * for — it is the strongest single argument against the decision and it is her own evidence.
 */
function refuseInstruction(why: string, recordedQualification?: string): string {
  const contradiction =
    recordedQualification === 'hot' || recordedQualification === 'warm'
      ? ` You recorded this lead as "${recordedQualification}" earlier in this same call, and nothing since then was a refusal.`
      : '';
  return (
    `The call is NOT ending and you have NOT said goodbye. ${why}${contradiction} ` +
    `Do not say any farewell, do not thank him for his time, and do not call end_call again yet. ` +
    `Ask him directly, in Hebrew, and then wait for his answer: "${END_CALL_CONFIRM_HE}" ` +
    `If he says yes, you may end the call. If he says anything else, carry on with the conversation.`
  );
}
