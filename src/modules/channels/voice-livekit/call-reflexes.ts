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

/**
 * The caller went silent (user state → 'away'). Strike 1 is a gentle, stage-aware check-in; strike 2
 * (or more) wraps and hangs up — a line that never gets a reply is a dead call, and Keren shouldn't
 * hold an empty line open.
 */
export function decideSilenceAction(strike: number, stage: CallStage): ReflexAction {
  if (strike >= 2) {
    return { say: SILENCE_WRAP_HE, teardown: true, endReason: 'no_answer' };
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
