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

  const tts = new cartesia.TTS({
    model: env.CARTESIA_MODEL,
    voice: env.CARTESIA_VOICE_ID_PRIMARY,
    language: env.VOICE_LANGUAGE,
  });

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
