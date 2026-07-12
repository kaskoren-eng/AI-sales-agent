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
    // PHASE 2 — END-OF-TURN IS THE BOTTLENECK.
    //
    // Measured on the first live Hebrew session: endOfUtteranceDelayMs was 1330-2506ms,
    // against a 300ms budget. It is over half of total perceived latency and on its own
    // breaks the "no dead air > 1.2s" criterion. Silero VAD only hears speech *energy*, so
    // end-of-turn falls back to a silence timer.
    //
    // DO NOT reach for @livekit/agents-plugin-livekit's MultilingualModel: its languages.json
    // lists de/en/es/fr/hi/id/it/ja/ko/nl/pt/ru/tr/zh — THERE IS NO HEBREW. It is installed
    // and is fine for a future English-speaking tenant, but it cannot help our primary market.
    //
    // The Hebrew-capable options, in order of expected payoff:
    //   1. OpenAI semantic_vad — predicts end-of-turn from meaning, not from a per-language
    //      model, so Hebrew works. Pass to openai.STT above:
    //        turnDetection: { type: 'semantic_vad', eagerness: 'high' }
    //   2. Tighten the silence timer: turnHandling.endpointing minDelay/maxDelay
    //      (defaults are 500/3000ms).
    // Measure before and after — do not tune blind.
  };
}
