import { initializeLogger } from '@livekit/agents';
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

/**
 * Models that accept an explicit `language`. Others must be called without it.
 *
 * `sonic-3.5` WAS MISSING HERE AND IT BROKE HEBREW ON EVERY CALL (2026-08-16). Without
 * `language`, Cartesia does not reliably infer Hebrew from the text — it renders Hebrew
 * characters with English phonetics, and the caller hears confident gibberish in the right
 * voice. It does not error, it does not warn, and the transcript in the call report is
 * perfect Hebrew, so the logs look healthy while the call is unusable.
 *
 * Verified against the live API before adding: sonic-3.5 + `language: 'he'` returns 200, and
 * the audio differs from the same request without it (133198 vs 125518 bytes) — proof the
 * parameter changes synthesis rather than being ignored.
 *
 * If you add a model here, TEST IT against /tts/bytes first. A model that rejects `language`
 * fails the call outright; one that silently ignores it is the trap above, in reverse.
 */
const MODELS_ACCEPTING_LANGUAGE = new Set(['sonic-3.5', 'sonic-3', 'sonic-2', 'sonic', 'sonic-lite']);

/**
 * `synthesizeHebrew` MOVED to ./tts-engine.ts on 2026-09-02, and it is not a tidy-up.
 *
 * It used to construct a Cartesia TTS by hand right here, which made every local
 * tool speak Cartesia no matter what `VOICE_TTS_PROVIDER` said. With the move to DeepDub that
 * would have meant a harness measuring an engine we no longer ship, silently. The replacement
 * resolves the engine through production's own `buildTTS()`.
 *
 * This file stays deliberately small and deliberately Cartesia-shaped: it is the CARTESIA options
 * and the logger, and it is imported by `agent.config.ts` — so it must not import `tts-engine.ts`
 * back (that would be a cycle through agent.config).
 */

