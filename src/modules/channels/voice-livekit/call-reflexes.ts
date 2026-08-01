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
 * An answering machine picked up (AMD). Leave the voicemail message and hang up — never run a
 * discovery call into a beep. `_category` (AMD's classification) is accepted for future
 * message-by-category tuning; today one message covers every machine.
 */
export function decideVoicemailAction(_category?: string): ReflexAction {
  return { say: VOICEMAIL_MESSAGE_HE, teardown: true, endReason: 'voicemail' };
}
