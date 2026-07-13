import { type stt as sttBase } from '@livekit/agents';
import * as soniox from '@livekit/agents-plugin-soniox';
import { CircuitBreaker } from '../../../../shared/circuit-breaker.js';
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

/** A single Soniox transcription of a fixed audio buffer, with the timings the A/B test needs. */
export interface SonioxTranscription {
  text: string;
  /** ms from first audio byte sent to the first token of ANY kind coming back (interim included). */
  timeToFirstTokenMs: number | null;
  /** ms from first audio byte sent to the last FINAL transcript. */
  timeToFinalMs: number | null;
  /** ms from the end of the audio to Soniox declaring the endpoint — its end-of-turn signal. */
  endpointDelayMs: number | null;
  /** Seconds of audio Soniox billed us for, straight from its RECOGNITION_USAGE event. */
  audioDurationSec: number;
}

/**
 * Transcribes a finite audio buffer through Soniox and measures it.
 *
 * Used by the A/B harness and by shadow mode — every path where we hand Soniox a known chunk of
 * audio and wait for an answer. That IS a request/response call, so it goes through the breaker.
 *
 * The plugin has no `recognize()` — it throws "does not support single frame recognition" — so the
 * only way in is the streaming interface, driven to completion and closed. Ending the input makes
 * the plugin send Soniox an empty frame, which flushes the remaining tokens and emits `finished`.
 */
export async function transcribeBuffer(
  stt: soniox.STT,
  frames: Array<{ data: Int16Array; sampleRate: number; samplesPerChannel: number }>,
  sttModule: typeof sttBase,
): Promise<SonioxTranscription> {
  return sonioxCircuit.execute(async () => {
    const stream = stt.stream();

    let firstTokenAt: number | null = null;
    let finalAt: number | null = null;
    let audioDurationSec = 0;
    const finals: string[] = [];

    // Push the audio, then close the input so Soniox flushes. Kept as a background task: the
    // consumer loop below must already be draining, or a long buffer would deadlock on backpressure.
    const startedAt = Date.now();
    let audioEndedAt = startedAt;
    const pump = (async () => {
      for (const frame of frames) {
        stream.pushFrame(frame as never);
      }
      audioEndedAt = Date.now();
      stream.endInput();
    })();

    for await (const ev of stream) {
      if (ev.type === sttModule.SpeechEventType.INTERIM_TRANSCRIPT && firstTokenAt === null) {
        firstTokenAt = Date.now();
      }
      if (ev.type === sttModule.SpeechEventType.FINAL_TRANSCRIPT) {
        firstTokenAt ??= Date.now();
        finalAt = Date.now();
        const text = ev.alternatives?.[0]?.text ?? '';
        if (text) finals.push(text);
      }
      if (ev.type === sttModule.SpeechEventType.RECOGNITION_USAGE) {
        audioDurationSec += ev.recognitionUsage?.audioDuration ?? 0;
      }
    }

    await pump;
    stream.close();

    return {
      text: finals.join(' ').trim(),
      timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      timeToFinalMs: finalAt === null ? null : finalAt - startedAt,
      // The honest end-of-turn number: how long AFTER the audio stopped Soniox took to call it.
      // This is the figure that competes with our ~1113ms Silero silence timer.
      endpointDelayMs: finalAt === null ? null : Math.max(0, finalAt - audioEndedAt),
      audioDurationSec,
    };
  });
}
