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
    // PHASE 2: Silero VAD only detects speech energy, so end-of-turn is decided by a silence
    // timer — which cuts Hebrew speakers off mid-clause. If that happens, add:
    //   turnHandling: { turnDetection: new livekit.turnDetector.MultilingualModel() }
    // from @livekit/agents-plugin-livekit, which reads the transcript to judge whether the
    // sentence actually ended. The package is installed and its weights are already downloaded.
  };
}
