import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Env } from '../../../../config/env.js';
import type { CartesiaEmotion, TtsOverrides } from '../tts/tts-settings.js';

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

export interface CartesiaCallOptions {
  model: string;
  voice: string | undefined;
  language?: string;
  speed: number;
  volume: number;
  emotion?: CartesiaEmotion[];
  apiKey?: string;
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
 *
 * `overrides` carries the per-tenant voice/prosody resolved from `tenants.settings.agent_persona`
 * (tts/tts-settings.ts). Called with one argument — as every bench and A/B harness does — the
 * result is byte-identical to before this parameter existed.
 */
export function cartesiaOptions(env: Env, overrides: TtsOverrides = {}): CartesiaCallOptions {
  // The tenant's model, if they picked one. Resolved FIRST because the language gate below asks
  // about the model that will actually speak — gating on the env model while sending the tenant's
  // would be exactly the silent-mismatch this function exists to prevent.
  const model = overrides.model ?? env.CARTESIA_MODEL;
  const opts: CartesiaCallOptions = {
    model,
    voice: overrides.voice ?? env.CARTESIA_VOICE_ID_PRIMARY,
    // Intelligibility levers for the 8kHz phone line, not cosmetics. Narrowband strips the high
    // frequencies that carry consonants; slowing down and speaking up are what make Hebrew
    // legible down a phone. Judge them on the -phone samples from `npm run voice:ab`.
    speed: overrides.speed ?? env.VOICE_TTS_SPEED,
    volume: overrides.volume ?? env.VOICE_TTS_VOLUME,
    // The plugin reads CARTESIA_API_KEY off process.env when this is absent. Passing it
    // explicitly means a missing key fails where it can be read, rather than becoming one more
    // way to produce an empty audio stream.
    ...(env.CARTESIA_API_KEY ? { apiKey: env.CARTESIA_API_KEY } : {}),
  };
  // The plugin's TTSOptions.emotion is an ARRAY, but only emotion[0] reaches the wire
  // (agents-plugin-cartesia/src/tts.ts — `generationConfig.emotion = opts.emotion[0]`). One value
  // is all Cartesia's generation_config accepts, so the array is a shape, not a list.
  if (overrides.emotion) opts.emotion = [overrides.emotion];
  if (acceptsLanguage(model)) {
    opts.language = env.VOICE_LANGUAGE;
  }
  return opts;
}

/**
 * Does this model accept an explicit `language`? Others must be called without it.
 *
 * THE `startsWith` IS LOAD-BEARING. An exact-match set silently excluded `sonic-3.5`, so selecting
 * it would have dropped `language: 'he'` and reproduced the sonic-turbo failure exactly: a one-shot
 * WAV that sounds fine, and mush on a live call, because streaming Cartesia token-by-token with no
 * declared language makes it guess per fragment — and on short Hebrew fragments it guesses wrong.
 * A new model in a family we know accepts the parameter must not have to be remembered here.
 */
function acceptsLanguage(model: string): boolean {
  return model.startsWith('sonic-3') || MODELS_ACCEPTING_LANGUAGE.has(model);
}

const MODELS_ACCEPTING_LANGUAGE = new Set(['sonic-2', 'sonic', 'sonic-lite']);

/**
 * Synthesizes Hebrew speech for the *synthetic caller* — i.e. this is the fake human, not the
 * agent. Reuses the same Cartesia voice the agent speaks with, which is imperfect (the agent
 * hears its own voice back) but keeps the harness dependency-free.
 *
 * Uses the websocket `stream()` path, NOT `synthesize()`. The REST path returns zero frames for
 * Hebrew on sonic-3 ("AudioByteStream: incomplete frame during flush") — the websocket path is
 * the one the live agent uses and is proven to work.
 */
export async function synthesizeHebrew(
  env: Env,
  text: string,
  overrides: TtsOverrides = {},
): Promise<AudioFrame[]> {
  ensureLogger();

  const tts = new cartesia.TTS(cartesiaOptions(env, overrides));

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
