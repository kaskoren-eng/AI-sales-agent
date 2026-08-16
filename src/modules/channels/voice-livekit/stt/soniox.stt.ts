import { stt as sttBase } from '@livekit/agents';
import * as soniox from '@livekit/agents-plugin-soniox';
import { CircuitBreaker } from '../../../../shared/circuit-breaker.js';
import { type MeasureOptions, type Measurement, measureStream } from './measure.js';
import type { Env } from '../../../../config/env.js';

/**
 * Soniox STT — configuration, not a wrapper.
 *
 * WHY THERE IS NO WRAPPER HERE. The original brief asked for a hand-written LiveKit-compatible
 * STT class over Soniox's WebSocket API. There is an OFFICIAL one — `@livekit/agents-plugin-soniox`,
 * published by LiveKit at 1.5.1, the same version as every other plugin we run. It already
 * subclasses `stt.STT`, so it drops straight into `AgentSession`. Hand-rolling ours would mean
 * owning the reconnect logic, the audio framing, the interim/final token state machine and the
 * `<end>`/`<fin>` endpoint protocol — all of it code LiveKit maintains and we would not.
 *
 * So this file is the thin part that IS ours: the Hebrew configuration, and the circuit breaker.
 */

/**
 * HONEST LIMIT OF THIS BREAKER — read before trusting it.
 *
 * A circuit breaker is a request/response device: `execute(fn)` runs a call that RETURNS, counts
 * the failures, and starts rejecting once the far end looks dead. Soniox's live path is not that
 * shape. It is one long-lived WebSocket, opened once per call and held for minutes, owned INSIDE
 * the plugin. There is no `fn` to wrap, and pretending otherwise by wrapping the constructor would
 * produce a breaker that guards nothing and reads, to the next person, as though it does.
 *
 * What this breaker genuinely covers: the discrete, awaitable Soniox calls WE own — the A/B harness
 * and shadow mode (`transcribeBuffer` below). Those are real fan-out risks: shadow mode runs on
 * every live call, and a Soniox outage there must never bleed into the caller's audio path.
 *
 * What guards the live streaming path instead: LiveKit's own `APIConnectionError` /
 * `APIStatusError` handling inside `SpeechStream.run()`, plus `AgentSession`'s STT fallback. That
 * is the plugin's job and it already does it.
 */
export const sonioxCircuit = new CircuitBreaker({
  name: 'soniox',
  failureThreshold: 5,
  cooldownMs: 30_000,
});

/**
 * Builds the Soniox STT with our Hebrew settings.
 *
 * `context.terms` is the whole reason Soniox is being evaluated. Hebrew STT invents plausible
 * nonsense from what it half-hears — on a real call it turned "קורן" into "קורנטיטרי". The fix is
 * to bias the recogniser toward the words we actually expect, and `gpt-realtime-whisper` REJECTS
 * the `prompt` parameter that would do it (see docs/phase-4-known-issues.md §1). That rejection is
 * the sole reason Phase 4 carries a "hybrid STT" workaround. Soniox accepts biasing terms on a
 * STREAMING connection, so if this holds up on Hebrew, the workaround is deleted rather than built.
 */
export function createSonioxSTT(env: Env): soniox.STT {
  if (!env.SONIOX_API_KEY) {
    throw new Error('STT_PROVIDER=soniox requires SONIOX_API_KEY');
  }

  return new soniox.STT({
    apiKey: env.SONIOX_API_KEY,
    model: env.SONIOX_MODEL,
    languageHints: [env.VOICE_LANGUAGE],
    // Left FALSE deliberately. Strict hints would force every token to Hebrew, which would kill the
    // phantom-English problem (line noise transcribing as the word "you")... and also mangle the
    // things Phase 4 must capture verbatim: an email address, and the brand name "ClickScales".
    // A caller spelling out their email in English letters is not an edge case, it is the booking.
    languageHintsStrict: false,
    // The biasing terms. VOICE_STT_PROMPT is authored as a Whisper-style comma-separated phrase
    // list, so split it back into the array Soniox wants rather than duplicating the vocabulary in
    // a second env var that would inevitably drift out of sync with the first.
    context: { terms: parseBiasTerms(env.VOICE_STT_PROMPT) },
    maxEndpointDelayMs: env.SONIOX_MAX_ENDPOINT_DELAY_MS,
    // Off: one caller per call, and diarization is billed work we cannot use.
    enableSpeakerDiarization: false,
    enableLanguageIdentification: true,
  });
}

/**
 * Makes preemptive generation work under `VOICE_TURN_DETECTION=stt`.
 *
 * THE BUG THIS EXISTS TO FIX. LiveKit only starts drafting a reply early from two places
 * (agents/dist/voice/audio_recognition.js):
 *
 *   FINAL_TRANSCRIPT     → gated on `vadBaseTurnDetection || userTurnCommitted`
 *   PREFLIGHT_TRANSCRIPT → gated on `turnDetectionMode !== 'manual' || userTurnCommitted`
 *
 * In `stt` mode `vadBaseTurnDetection` is FALSE and the turn is not yet committed, so the FINAL
 * path never fires. That leaves the PREFLIGHT path — and the Soniox plugin only emits PREFLIGHT
 * when it holds final text with NO non-final token pending, which on a live call is a window of
 * approximately zero: Soniox finalizes its tokens at the same moment it emits the `<end>`
 * endpoint. Net effect: switching to `stt` silently disabled preemptive generation entirely.
 * Measured on the deployed agent — 0 "starting preemptive generation" across a whole call in
 * `stt`, 4 in `vad`, with every other setting identical.
 *
 * THE FIX. Re-label a *settled* interim as PREFLIGHT. Soniox re-emits its interim transcript
 * periodically; when two consecutive interims carry identical text, the caller has stopped
 * producing new words and the transcript is as good as it will get before the endpoint. That is
 * exactly the moment worth drafting from, and it arrives several hundred ms before `<end>`.
 *
 * WHY THIS IS SAFE. It changes only the event LABEL, never the text, and only ever upgrades
 * INTERIM → PREFLIGHT (never touches FINAL, END_OF_SPEECH, or START_OF_SPEECH). A draft built
 * from a transcript that the caller then extends is discarded by the SDK's own context check,
 * and `preemptiveGeneration.maxRetries` (default 2) caps how many drafts a single turn can spawn.
 * The worst case is two wasted LLM drafts per turn; the best case is the whole LLM TTFT hiding
 * behind the endpoint wait.
 */
export function withSettledPreflight(inner: soniox.STT): soniox.STT {
  // Instance-level shadow of `stream`, NOT a Proxy. The first attempt at this used a Proxy over
  // the STT and its SpeechStream, and it broke the agent outright — "AgentSession is not running"
  // before the greeting — because the SDK's classes use JS private fields (`#private`), which
  // throw when touched through a Proxy receiver. Assigning an own property here shadows the
  // prototype method while `this` stays the real instance, so private fields keep working.
  const originalStream = inner.stream.bind(inner);
  (inner as unknown as { stream: (...a: unknown[]) => sttBase.SpeechStream }).stream = (
    ...args: unknown[]
  ) => {
    const stream = originalStream(...(args as []));
    patchQueueWithSettledPreflight(stream);
    return stream;
  };
  return inner;
}

/** Extracts the primary alternative's text, or '' when the event carries none. */
function eventText(ev: sttBase.SpeechEvent): string {
  return ev.alternatives?.[0]?.text ?? '';
}

/**
 * Rewrites events on their way out of the plugin.
 *
 * EVERY event the Soniox plugin produces goes through `this.queue.put(...)` (its private `#put`,
 * plugin dist/stt.js:216). `queue` is a plain AsyncIterableQueue held in a normal property, so
 * patching `put` on that one object intercepts the whole event stream without touching the
 * stream class itself. That is why this works where the Proxy did not.
 */
function patchQueueWithSettledPreflight(stream: sttBase.SpeechStream): void {
  const holder = stream as unknown as {
    queue?: { put: (ev: sttBase.SpeechEvent) => void; closed?: boolean };
  };
  const queue = holder.queue;
  if (!queue || typeof queue.put !== 'function') {
    // Plugin internals changed shape. Do nothing rather than crash the call: the cost is the
    // lost overlap we are trying to win, not a dead agent.
    console.warn('settled_preflight_disabled', JSON.stringify({ reason: 'queue_not_found' }));
    return;
  }

  let lastInterim: string | null = null;
  let alreadyFlagged = false;
  const originalPut = queue.put.bind(queue);

  queue.put = (ev: sttBase.SpeechEvent) => {
    // Any non-interim event ends the current settle window — the next turn starts fresh.
    if (ev.type !== sttBase.SpeechEventType.INTERIM_TRANSCRIPT) {
      lastInterim = null;
      alreadyFlagged = false;
      return originalPut(ev);
    }

    const text = eventText(ev).trim();
    if (!text) return originalPut(ev);

    const settled = text === lastInterim;
    lastInterim = text;

    // Only the FIRST settled repeat is promoted. Later identical interims add nothing and would
    // burn preemptive retries (maxRetries defaults to 2) that a genuinely new transcript should get.
    if (settled && !alreadyFlagged) {
      alreadyFlagged = true;
      return originalPut({ ...ev, type: sttBase.SpeechEventType.PREFLIGHT_TRANSCRIPT });
    }
    return originalPut(ev);
  };
}

/** Splits the Whisper-style biasing prompt ("קורן, ClickScales, פגישה") into Soniox's term array. */
export function parseBiasTerms(prompt: string): string[] {
  return prompt
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/**
 * Transcribes a finite audio buffer through Soniox, via the breaker.
 *
 * This is the shape a circuit breaker actually fits: hand it a known chunk of audio, wait for an
 * answer. Used by shadow mode, which runs on EVERY live call — a Soniox outage there must never
 * bleed into the caller's audio path, and after 5 consecutive failures this stops trying entirely.
 *
 * The measurement itself is `measureStream`, which is engine-agnostic and shared with the OpenAI
 * arm of the A/B, so neither engine can be advantaged by how it was driven.
 */
export async function transcribeBuffer(
  stt: soniox.STT,
  pcm: Int16Array,
  sampleRate: number,
  opts: MeasureOptions = {},
): Promise<Measurement> {
  return sonioxCircuit.execute(() => measureStream(stt, pcm, sampleRate, opts));
}
