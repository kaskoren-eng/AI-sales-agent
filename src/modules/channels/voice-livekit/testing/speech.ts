import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Env } from '../../../../config/env.js';

let loggerReady = false;

/**
 * The LiveKit plugins log through a module-level pino instance that the agent CLI normally
 * initialises. Harness scripts don't go through the CLI, so any plugin call throws
 * "logger not initialized" until we do it ourselves.
 */
export function ensureLogger(level = 'error'): void {
  if (loggerReady) return;
  initializeLogger({ pretty: false, level });
  loggerReady = true;
}

/**
 * Cartesia TTS options — the single source of truth for how we call Cartesia, shared by the agent
 * and the test harness so they can't drift apart.
 *
 * THE LANGUAGE PARAMETER IS A TRAP. `sonic-turbo` REJECTS `language: 'he'` with
 * "Invalid language for model", and the LiveKit plugin surfaces that only as a DEBUG line and an
 * empty audio stream — no throw, no error. It looks exactly like "this model can't speak Hebrew",
 * and it isn't: drop the language and sonic-turbo synthesizes Hebrew fine.
 *
 * So: only declare the language on models that accept it. Never infer a model's language support
 * from an empty response.
 */
export function cartesiaOptions(env: Env): {
  model: string;
  voice: string | undefined;
  language?: string;
  speed: number;
  volume: number;
} {
  const model = env.CARTESIA_MODEL;
  const opts: {
    model: string;
    voice: string | undefined;
    language?: string;
    speed: number;
    volume: number;
  } = {
    model,
    voice: env.CARTESIA_VOICE_ID_PRIMARY,
    // Intelligibility levers for the 8kHz phone line, not cosmetics. Narrowband strips the high
    // frequencies that carry consonants; slowing down and speaking up are what make Hebrew
    // legible down a phone. Judge them on the -phone samples from `npm run voice:ab`.
    speed: env.VOICE_TTS_SPEED,
    volume: env.VOICE_TTS_VOLUME,
  };
  if (MODELS_ACCEPTING_LANGUAGE.has(model)) {
    opts.language = env.VOICE_LANGUAGE;
  }
  return opts;
}

/** Models that accept an explicit `language`. Others must be called without it. */
const MODELS_ACCEPTING_LANGUAGE = new Set(['sonic-3', 'sonic-2', 'sonic', 'sonic-lite']);

/**
 * Synthesizes Hebrew speech for the *synthetic caller* — i.e. this is the fake human, not the
 * agent. Reuses the same Cartesia voice the agent speaks with, which is imperfect (the agent
 * hears its own voice back) but keeps the harness dependency-free.
 *
 * Uses the websocket `stream()` path, NOT `synthesize()`. The REST path returns zero frames for
 * Hebrew on sonic-3 ("AudioByteStream: incomplete frame during flush") — the websocket path is
 * the one the live agent uses and is proven to work.
 */
export async function synthesizeHebrew(env: Env, text: string): Promise<AudioFrame[]> {
  ensureLogger();

  const tts = new cartesia.TTS(cartesiaOptions(env));

  const stream = tts.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();

  const frames: AudioFrame[] = [];
  for await (const ev of stream) {
    if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
    frames.push(ev.frame);
  }
  stream.close();

  if (frames.length === 0) {
    throw new Error(`Cartesia returned no audio for: ${text.slice(0, 40)}`);
  }
  return frames;
}
