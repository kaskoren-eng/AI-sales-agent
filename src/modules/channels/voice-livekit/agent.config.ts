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
      // Valid models per the plugin's TTSModels type: sonic, sonic-2, sonic-2-2025-03-07,
      // sonic-3, sonic-lite, sonic-preview, sonic-turbo. There is no sonic-4.
      // PHASE 2: A/B `sonic-turbo` — it is the low-latency variant and the first lever
      // to pull towards the P95 < 800ms target.
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
    },
    // Remaining Phase 2 levers, in expected order of payoff:
    //   - LLM ttft ~740-1060ms vs 300ms budget: prompt caching, a smaller/faster model, or
    //     turnHandling.preemptiveGeneration (start generating before the turn is confirmed).
    //   - TTS ttfb ~390ms vs 100ms budget: A/B `sonic-turbo`, Cartesia's low-latency model.
  };
}
