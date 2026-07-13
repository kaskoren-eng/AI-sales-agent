import type { voice } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as openai from '@livekit/agents-plugin-openai';
import type * as silero from '@livekit/agents-plugin-silero';
import { cartesiaOptions } from './testing/speech.js';
import type { Env } from '../../../config/env.js';

/**
 * Builds the cascade pipeline: STT -> LLM -> TTS.
 *
 * Split out of `agent.ts` because that file calls `cli.runApp()` at import time — importing it
 * from a test would boot a LiveKit worker. This module is safe to import.
 *
 * Every stage streams; nothing here may buffer a full response between stages
 * (`docs/voice-agent-development-methodology.md`, principle #3).
 */
export function buildSessionComponents(env: Env, vad: silero.VAD): voice.AgentSessionOptions {
  return {
    vad,
    // gpt-realtime-whisper streams partial transcripts over a WebSocket as the caller speaks.
    // If Hebrew accuracy disappoints, fall back to whisper-1 (REST, non-streaming, slower).
    stt: new openai.STT({
      model: env.OPENAI_REALTIME_MODEL,
      language: env.VOICE_LANGUAGE,
      useRealtime: true,
      vad,
      // NOTE: do NOT pass `turnDetection: { type: 'semantic_vad' }` here. It typechecks, the
      // worker boots clean, and it does NOTHING — gpt-realtime-whisper is a transcription-only
      // model and the plugin logs "Turn detection is not supported for gpt-realtime-whisper;
      // ignoring the provided turnDetection". Measured with the synthetic caller: identical
      // end-of-utterance delay with and without it. End-of-turn is tuned below instead.
    }),
    llm: new openai.LLM({ model: env.AI_MODEL }),
    // Options come from cartesiaOptions() so the agent and the test harness cannot drift apart.
    // It also handles the language trap: sonic-turbo REJECTS language:'he' ("Invalid language for
    // model") and returns an empty stream with only a DEBUG log — which looks identical to "this
    // model has no Hebrew", but isn't. Drop the language and sonic-turbo speaks Hebrew fine.
    // Compare models with: npm run voice:ab -- <model>
    tts: new cartesia.TTS(cartesiaOptions(env)),
    turnHandling: {
      // NO OFF-THE-SHELF END-OF-TURN MODEL SUPPORTS HEBREW. All three were checked:
      //   - @livekit/agents-plugin-livekit MultilingualModel — languages.json has no `he`
      //   - LiveKit inference turn-detector-v1 — languages.js has no `he` (it has Arabic!)
      //   - OpenAI semantic_vad — silently ignored by gpt-realtime-whisper (see STT above)
      // So we are left with a plain silence timer, whose delay is max(Silero silence, minDelay).
      //
      // Measured with `npm run voice:test` (synthetic Hebrew caller), dead-air p50:
      //   silero 550 / minDelay 500 → 4534ms
      //   silero 400 / minDelay 300 → 3898ms
      //   silero 250 / minDelay 200 → 3631ms  ← current default, 0 cut-offs
      // Caveat that matters: those runs had ZERO cut-offs, but the synthetic caller's pauses are
      // SHORTER than a real person's. Zero cut-offs here is not proof it won't talk over a live
      // caller. If that happens, raise these two first — being interrupted mid-sentence is a far
      // worse product failure than 300ms of extra latency.
      turnDetection: 'vad',
      endpointing: {
        minDelay: env.VOICE_ENDPOINTING_MIN_DELAY_MS,
        maxDelay: env.VOICE_ENDPOINTING_MAX_DELAY_MS,
      },
      preemptiveGeneration: {
        // `enabled` already defaults to true, so the LLM was ALREADY overlapping the endpointing
        // wait — that is why ~800ms of LLM ttft was not showing up as ~800ms of extra dead air.
        enabled: true,
        // Defaults to FALSE. In theory it should hide Cartesia's ~390ms behind the endpointing
        // wait; in the first measured run it made things WORSE (TTS ttfb rose 390->550ms, and
        // discarded drafts add load). Left off by default and made switchable so it can be
        // re-measured rather than argued about.
        preemptiveTts: env.VOICE_PREEMPTIVE_TTS,
      },
    },
    // Start drafting the reply from the partial transcript, before end-of-turn is confirmed,
    // so the ~1.2s endpointing wait and the ~800ms LLM first-token overlap instead of adding up.
    // This is the one lever that attacks the end-of-turn wall without risking cutting callers
    // off: if the caller turns out not to have finished, the draft is discarded.
    // Costs some wasted LLM tokens on discarded drafts — worth it at ~1s saved per turn.
  };
}
