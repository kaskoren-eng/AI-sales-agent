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
      // semantic_vad judges "has the caller finished?" from meaning rather than from silence,
      // so it works in Hebrew — unlike LiveKit's turn detector, which has no Hebrew model.
      // Silence-timer endpointing measured 1227-2506ms; this is the lever against that.
      // `eagerness: 'high'` = answer sooner. If it starts cutting callers off mid-sentence,
      // step down to 'medium' / 'low' — that is the speed-vs-patience dial.
      turnDetection: { type: 'semantic_vad', eagerness: 'high' },
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
      // Take end-of-turn from the STT's semantic_vad (above), NOT from a silence timer.
      // This half is essential: left unset, the session auto-selects 'vad' and the
      // semantic_vad signal is computed and then ignored.
      turnDetection: 'stt',
    },
    // Silero VAD only hears speech *energy*, so it cannot tell "thinking mid-sentence" from
    // "finished". It stays for barge-in detection, but no longer decides turns.
    //
    // DO NOT reach for @livekit/agents-plugin-livekit's MultilingualModel as the Hebrew fix:
    // its languages.json lists de/en/es/fr/hi/id/it/ja/ko/nl/pt/ru/tr/zh — THERE IS NO HEBREW.
    // It stays in package.json as a valid option for a future English-speaking tenant only.
    //
    // Remaining Phase 2 levers, in expected order of payoff:
    //   - LLM ttft ~740ms vs 300ms budget: prompt caching, a smaller model, or preemptive
    //     generation (turnHandling.preemptiveGeneration).
    //   - TTS ttfb ~390ms vs 100ms budget: A/B `sonic-turbo`, Cartesia's low-latency model.
    // Measure before and after — do not tune blind.
  };
}
