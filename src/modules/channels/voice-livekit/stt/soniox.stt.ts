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
