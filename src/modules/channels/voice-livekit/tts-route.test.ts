import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLogger } from '@livekit/agents';
import { buildTTS } from './agent.config.js';
import type { Env } from '../../../config/env.js';

/**
 * THE BUG THESE EXIST FOR.
 *
 * The gateway route (`CARTESIA_ROUTE=inference`) and the direct Cartesia plugin have DIFFERENT
 * DEFAULTS: the plugin asks for 24kHz, the gateway for 16kHz — and the gateway takes speed/volume
 * inside `modelOptions`, not top-level. The first gateway branch shipped with none of them, so a
 * real caller got 16kHz audio (then squeezed to 8kHz for the phone — degraded twice) at untuned
 * speed and volume. The corrected branch existed in the same file the whole time — as dead code
 * behind a route flag that was never on.
 *
 * Nothing failed. No test asserted what the route we actually ship sends. These do.
 */

const env = (over: Partial<Env> = {}): Env =>
  ({
    VOICE_TTS_PROVIDER: 'cartesia',
    CARTESIA_ROUTE: 'inference',
    VOICE_TTS_ROUTE: 'cartesia',
    CARTESIA_MODEL: 'sonic-3.5',
    CARTESIA_VOICE_ID_PRIMARY: 'voice-id',
    VOICE_LANGUAGE: 'he',
    VOICE_TTS_SPEED: 0.9,
    VOICE_TTS_VOLUME: 1.4,
    ...over,
  }) as unknown as Env;

// inference.TTS signs its gateway connection at construction time; no network happens until a
// stream is opened, but the constructor throws without credentials.
beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
  process.env.LIVEKIT_API_KEY ??= 'test-key';
  process.env.LIVEKIT_API_SECRET ??= 'test-secret';
});

type InferenceOpts = {
  model: string;
  voice?: string;
  language?: string;
  sampleRate: number;
  modelOptions: { speed?: number; volume?: number };
};

function inferenceOpts(e: Env): InferenceOpts {
  const tts = buildTTS(e);
  expect(tts.label).toBe('inference.TTS');
  return (tts as unknown as { opts: InferenceOpts }).opts;
}

describe('the gateway route sends everything the direct route sends', () => {
  it('asks for 24kHz explicitly — the gateway default is 16kHz', () => {
    expect(inferenceOpts(env()).sampleRate).toBe(24_000);
  });

  it('carries the ear-tuned speed and volume in modelOptions', () => {
    const opts = inferenceOpts(env());
    expect(opts.modelOptions.speed).toBe(0.9);
    expect(opts.modelOptions.volume).toBe(1.4);
  });

  it('ships the configured model, not a hardcoded one', () => {
    expect(inferenceOpts(env()).model).toBe('cartesia/sonic-3.5');
    expect(inferenceOpts(env({ CARTESIA_MODEL: 'sonic-3' })).model).toBe('cartesia/sonic-3');
  });

  it('names the language explicitly — gateway auto-detect transliterates Hebrew', () => {
    expect(inferenceOpts(env()).language).toBe('he');
  });

  /**
   * The legacy flag must not resurrect a second, divergent branch: both spellings of "inference"
   * land on the SAME code path with the same options.
   */
  it('VOICE_TTS_ROUTE=inference reaches the same corrected branch', () => {
    const opts = inferenceOpts(env({ CARTESIA_ROUTE: 'direct', VOICE_TTS_ROUTE: 'inference' }));
    expect(opts.sampleRate).toBe(24_000);
    expect(opts.modelOptions.speed).toBe(0.9);
  });
});
