import * as soniox from '@livekit/agents-plugin-soniox';
import { CircuitBreaker } from '../../../../shared/circuit-breaker.js';
import { type MeasureOptions, type Measurement, measureStream } from './measure.js';
import type { Env } from '../../../../config/env.js';

/**
 * Soniox STT — configuration plus ONE capability the plugin is missing: turn finalization.
 *
 * WHY THERE IS (STILL) NO FULL WRAPPER HERE. The original brief asked for a hand-written
 * LiveKit-compatible STT class over Soniox's WebSocket API. There is an OFFICIAL one —
 * `@livekit/agents-plugin-soniox` — and it owns the reconnect logic, the audio framing, the
 * interim/final token state machine and the `<end>`/`<fin>` endpoint protocol. We keep it that way.
 *
 * ── THE PAUSE-ARM EOU FIX (2026-08-24) ────────────────────────────────────────────────────────
 *
 * The SDK will not commit a turn until Soniox delivers a FINAL transcript, and Soniox only marks
 * text final when ITS OWN endpoint detector fires — floored at 500ms by their API. So on any turn
 * where the caller trails off, Silero's 200ms verdict sits waiting for Soniox's 500ms one:
 * measured EOU 566-758ms on those turns versus 226ms on clean ones, with the preemptive draft
 * already generated and ready to speak.
 *
 * Soniox's protocol has the answer built in: a client-sent `{"type":"finalize"}` forces all
 * pending tokens final, answered by the `<fin>` token — which the plugin ALREADY treats as an end
 * token. Their docs even prescribe our exact trigger: "call finalize only after sending
 * approximately 200ms of silence following the end of speech" — which is precisely what Silero's
 * minSilenceDuration=200 gives us, surfaced as UserStateChanged speaking→listening.
 *
 * Two pieces make it work:
 *  1. patches/@livekit+agents-plugin-soniox+1.5.1.patch — the plugin's send loop receives the
 *     SDK's FLUSH_SENTINEL and ignored it (`continue`); patched to send `{"type":"finalize"}`.
 *     Routing it through flush() means the finalize rides the SAME queue as the audio frames, so
 *     it can never overtake the tail of the caller's speech.
 *  2. FinalizingSonioxSTT below — tracks the active stream so `finalizeTurn()` (called from the
 *     agent's UserStateChanged handler) can reach it.
 *
 * This is NOT VOICE_TURN_DETECTION=stt in disguise. That mode let Soniox DECIDE when the turn
 * ends (it cut a real caller off ten times — phase-4-known-issues §11 — and stays banned). Here
 * the decision stays with Silero, on the same criteria as today; Soniox is only told to stop
 * second-guessing a decision that has already been made. If the caller resumes speaking, nothing
 * is lost: finalize does not close the stream, and new audio keeps transcribing.
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
/** Minimum gap between finalize requests. Soniox tolerates one every few seconds; a flapping VAD
 * (breath, line noise) must not turn into a finalize storm that gets the socket dropped. */
const FINALIZE_MIN_INTERVAL_MS = 1_000;

export class FinalizingSonioxSTT extends soniox.STT {
  #activeStream: soniox.SpeechStream | null = null;
  #lastFinalizeAt = 0;

  override stream(options?: Parameters<soniox.STT['stream']>[0]): soniox.SpeechStream {
    const s = super.stream(options);
    this.#activeStream = s;
    return s;
  }

  /**
   * Tell Soniox to finalize everything heard so far. Called when Silero declares end-of-speech —
   * the moment the SDK starts waiting for a FINAL transcript that Soniox would otherwise sit on
   * for up to 500ms. Safe to call redundantly: a finalize with nothing pending returns an empty
   * `<fin>` that the SDK discards, and the rate limit keeps a flapping VAD from spamming it.
   */
  finalizeTurn(): void {
    const s = this.#activeStream;
    // `closed` is a real public field at runtime but declared protected in the SDK types.
    if (!s || (s as unknown as { closed: boolean }).closed) return;
    const now = Date.now();
    if (now - this.#lastFinalizeAt < FINALIZE_MIN_INTERVAL_MS) return;
    this.#lastFinalizeAt = now;
    // flush() enqueues FLUSH_SENTINEL behind any buffered audio; the patched plugin turns the
    // sentinel into the `{"type":"finalize"}` websocket message. See the patch + header comment.
    s.flush();
  }
}

export function createSonioxSTT(env: Env): FinalizingSonioxSTT {
  if (!env.SONIOX_API_KEY) {
    throw new Error('STT_PROVIDER=soniox requires SONIOX_API_KEY');
  }

  return new FinalizingSonioxSTT({
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
