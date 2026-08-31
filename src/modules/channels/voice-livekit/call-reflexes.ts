/**
 * Reflex-decision logic — the pure "given this event, what does Keren do?" functions.
 *
 * Kept SEPARATE from agent.ts because agent.ts calls `cli.runApp()` at import (it owns the process)
 * and so cannot be imported by tests. These functions carry no side effects: they return an action
 * (what to say, whether to hang up, and the end reason) that the agent's event handlers execute.
 *
 * The system-only end reasons (`no_answer`, `voicemail`) are set here on the runtime directly by the
 * reflex — they are deliberately NOT in the LLM's end_call reason enum, so the model can never
 * self-select them.
 */

import type { CallStage } from './call-state.js';
import { SILENCE_NUDGE_HE, SILENCE_WRAP_HE, VOICEMAIL_MESSAGE_HE } from './call-state-lines.he.js';

export type SystemEndReason = 'no_answer' | 'voicemail';

export interface ReflexAction {
  /** The line Keren speaks (verbatim, via session.say). */
  say: string;
  /** Whether the call should end after the line finishes playing. */
  teardown: boolean;
  /** The end reason to stamp on the call when tearing down. */
  endReason?: SystemEndReason;
}

/** After this many check-ins Keren stops nudging and simply holds the line, waiting quietly. */
export const MAX_SILENCE_NUDGES = 2;

/**
 * The caller went silent (user state → 'away'). A pause is NOT a dead call: a human thinking,
 * checking a detail, or muting for a moment must never lose the call — so the silence reflex NEVER
 * hangs up. Strike 1 is a gentle, stage-aware check-in; strike 2 reassures and explicitly holds the
 * line; beyond that she stays quiet and keeps waiting (returns null → the handler does nothing). A
 * caller who has genuinely gone is torn down by the SDK's `participant_disconnected`, not here.
 */
export function decideSilenceAction(strike: number, stage: CallStage): ReflexAction | null {
  if (strike > MAX_SILENCE_NUDGES) return null;
  if (strike >= 2) {
    return { say: SILENCE_WRAP_HE, teardown: false };
  }
  return { say: SILENCE_NUDGE_HE[stage] ?? SILENCE_NUDGE_HE.discovery, teardown: false };
}

/**
 * How long the CALLER has actually been quiet, against how long he is allowed to think.
 *
 * ── WHY THIS IS NOT JUST A BIGGER NUMBER ─────────────────────────────────────────────────────
 *
 * The 2026-08-31 13:52 production call fired the silence reflex TWICE inside the first minute of a
 * 3.5-minute call — 7287ms at 27s and 7345ms at 46s, both `endedBy: silence_reflex`. At 36s she
 * asked "אתה עדיין איתי?" and he answered "כן, אני פה"; at 57s she said "אני כאן, אין לחץ" into a
 * pause he was clearly still thinking in. Both landed immediately after she had asked him an OPEN
 * discovery question, which is precisely when a person needs a few seconds.
 *
 * WHAT THE CALL DATA ACTUALLY SAYS, read off the metric stream rather than assumed. In both windows
 * NOTHING ran: no STT final, no end-of-turn, no LLM request, no preemptive draft, no tool. The
 * caller was not mid-utterance and no turn was in flight — so suppressing the reflex "while speech
 * is in flight" would not have prevented either of these, and this function deliberately does not
 * pretend otherwise. He was simply thinking, in silence, with nothing on the line.
 *
 * The same is true of the two 15s silences on the 08:37 call the same morning, which is what set
 * the timer to 7000 in the first place. Every `away` event across both instrumented production
 * calls was a thinking caller; not one was a dead line, and in every case he spoke on his own 2-5s
 * after the nudge and 11-20s after she stopped. The nudge has never yet rescued a call, and it has
 * twice interrupted a man mid-thought.
 *
 * So the lever is TIME, but it is a time that has to be measured from the right event and kept
 * apart from the SDK's own state machine — which is what this function is for. `awayMs` (LiveKit's
 * `userAwayTimeout`) still decides when the caller is *away*, and the call report still attributes
 * gaps by it. `minQuietMs` decides when she is allowed to SAY something about it.
 *
 * Returns the number of ms still to wait, or 0 when the nudge may go now. `minQuietMs = 0`
 * restores the 2026-08-31 behaviour exactly: nudge the instant the SDK says 'away'.
 */
export function silenceNudgeWaitMs(quietForMs: number, minQuietMs: number): number {
  if (minQuietMs <= 0) return 0;
  const remaining = minQuietMs - quietForMs;
  return remaining > 0 ? remaining : 0;
}

/**
 * An answering machine picked up (AMD). Leave the voicemail message and hang up — never run a
 * discovery call into a beep. `_category` (AMD's classification) is accepted for future
 * message-by-category tuning; today one message covers every machine.
 *
 * `message` is the tenant's own, built from their persona by the caller. It defaults to
 * ClickScales' so benches and the existing reflex tests are unaffected — but a live call always
 * passes one, because this is the only line the agent speaks that outlives the call.
 */
export function decideVoicemailAction(
  _category?: string,
  message: string = VOICEMAIL_MESSAGE_HE,
): ReflexAction {
  return { say: message, teardown: true, endReason: 'voicemail' };
}
