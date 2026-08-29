/**
 * What she says at the START of one inference step — and why a tool call changes the answer.
 *
 * THE BUG THIS EXISTS TO FIX (Koren, 2026-08-29, live PSTN call):
 *
 *     "אהה."   @ 29.3s        <- one word, alone
 *     ...5.4 seconds of nothing...
 *     "אוקיי. כמה פניות נכנסות אליךָ ביום..."   @ 34.7s
 *
 * He heard it as a script: "she stops after one word and then continue to the other word... it
 * sounds like she got something like script to say." Both of those words are ours. Neither is the
 * thinking filler — `"אהה."` and `"כן."` are members of ACKNOWLEDGEMENTS_HE, and the gap between
 * them is a TOOL CALL.
 *
 * THE MECHANISM, read out of the SDK rather than guessed (agent_activity.js `produceSegments`):
 * `startSegment()` — and therefore `ttsNode` — runs on the FIRST TEXT CHUNK of an inference step.
 * `llmNode` injects the acknowledgement before the model has written anything, so a step whose
 * only real output is a tool call still produces one spoken word. Then the tool runs
 * (capture_lead_info 1025ms, request_human_handoff 971ms), a SECOND inference step starts, and
 * that step injects its OWN acknowledgement in front of the actual sentence. One caller turn,
 * two receipts, a multi-second hole between them.
 *
 * THE RULE: the first step of a turn opens with a receipt ("I heard you"). A step that follows a
 * tool call opens with a HESITATION ("אממ...") instead — because by then the caller has already
 * been acknowledged, and what the moment actually calls for is the sound of someone still
 * working on it. A second receipt is the robot; a hesitation before the answer is a person.
 *
 * When the call has spent its filler budget the step opens with NOTHING. Silence is always an
 * acceptable answer here — it is the extra word that made her sound like a machine, never the
 * missing one.
 */
import { pickAcknowledgement } from './prompts/acknowledgements.he.js';

export type TurnOpener =
  /** A receipt spoken before the model has written a word — the <1s mechanism. */
  | { kind: 'ack'; word: string }
  /** A hesitation covering a tool call that already interrupted her. */
  | { kind: 'hesitation'; word: string }
  /** Say nothing at the start of this step. */
  | { kind: 'silent' };

export function chooseTurnOpener(input: {
  /** True when the PREVIOUS inference step of this same reply emitted a tool call. */
  afterToolCall: boolean;
  /** `VOICE_THINKING_FILLER_MS !== 0` — the existing thinking-filler kill-switch. */
  fillersEnabled: boolean;
  /** The acknowledgement spoken on the previous step, so we never repeat it back-to-back. */
  lastAck: string | null;
  /** The call's filler budget — `ThinkingFillerLedger.offer()`. Returns null when spent. */
  offerFiller: () => string | null;
}): TurnOpener {
  if (input.afterToolCall) {
    // She has already been heard on this turn. A second "אוקיי." is the duplicate receipt Koren
    // heard; the honest sound here is hesitation, or nothing.
    if (!input.fillersEnabled) return { kind: 'silent' };
    const filler = input.offerFiller();
    return filler ? { kind: 'hesitation', word: filler } : { kind: 'silent' };
  }
  return { kind: 'ack', word: pickAcknowledgement(input.lastAck) };
}

/**
 * Does this LLM chunk carry a tool call?
 *
 * The SDK hands `llmNode` a union: our own injected strings, flush sentinels, and the model's
 * `ChatChunk`s. Only the last kind can carry `delta.toolCalls` — that is the field
 * `performLLMInference` itself reads to feed the tool executor (generation.js:394), so this asks
 * the same question of the same field rather than inferring from timing.
 */
export function chunkCallsTool(chunk: unknown): boolean {
  if (typeof chunk !== 'object' || chunk === null) return false;
  const delta = (chunk as { delta?: { toolCalls?: unknown } }).delta;
  if (!delta || typeof delta !== 'object') return false;
  return Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0;
}
