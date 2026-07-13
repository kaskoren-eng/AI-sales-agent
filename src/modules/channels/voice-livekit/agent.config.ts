import type { voice } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as openai from '@livekit/agents-plugin-openai';
import type * as silero from '@livekit/agents-plugin-silero';
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
    tts: new cartesia.TTS({
      // sonic-3 IS THE ONLY CARTESIA MODEL THAT SPEAKS HEBREW. Verified by synthesizing the
      // same Hebrew line on each: sonic, sonic-2, sonic-lite and sonic-turbo all return ZERO
      // audio (a 44-byte WAV header, no samples) — they fail silently rather than erroring.
      // So `sonic-turbo`, the low-latency variant, is NOT available to us and TTS ttfb (~390ms)
      // is a floor, not a tuning target. Do not "optimise" this to a faster model.
      // Re-check with: npm run voice:ab -- <model>
      model: env.CARTESIA_MODEL,
      voice: env.CARTESIA_VOICE_ID_PRIMARY,
      language: env.VOICE_LANGUAGE,
    }),
    turnHandling: {
      // NO OFF-THE-SHELF END-OF-TURN MODEL SUPPORTS HEBREW. All three were checked:
      //   - @livekit/agents-plugin-livekit MultilingualModel — languages.json has no `he`
      //   - LiveKit inference turn-detector-v1 — languages.js has no `he` (it has Arabic!)
      //   - OpenAI semantic_vad — silently ignored by gpt-realtime-whisper (see STT above)
      // So we are left with a plain silence timer, whose delay is max(Silero silence, minDelay).
      //
      // Measured with `npm run voice:test` (synthetic Hebrew caller):
      //   silero 550 / minDelay 500 (defaults) → end-of-turn 1200-1443ms, 0 cut-offs
      //   silero 250 / minDelay 200            → end-of-turn  955-1569ms, 0 cut-offs
      // i.e. tuning buys ~200-300ms of the ~1100ms we need. It is NOT the fix; the fix is a
      // Hebrew-capable EOT model, which does not exist off the shelf. See README.
      //
      // Defaults left conservative on purpose: being cut off mid-sentence is a far worse
      // product failure than 300ms of latency, and the "hesitation" scenario only proves the
      // tight config survives SYNTHETIC pauses, which are shorter than real human ones.
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
