import { describe, expect, it } from 'vitest';
import type { Env } from '../../../../config/env.js';
import { DeepdubTTS, deepdubCircuit, deepdubOptions } from './deepdub.tts.js';

/**
 * Unit tests for the DeepDub TTS adapter. These cover the parts that do NOT touch the network:
 * option validation/mapping and the LiveKit `tts.TTS` surface. The streaming path itself is proven
 * end-to-end by `scripts/deepdub-tts-smoke.mjs`, which drives a real synthesis to a WAV.
 */

const baseEnv = {
  DEEPDUB_API_KEY: 'dd-test-key',
  DEEPDUB_VOICE_PROMPT_ID: 'voice-123',
  DEEPDUB_MODEL: 'dd-etts-3.2',
  DEEPDUB_REALTIME: true,
  DEEPDUB_LOCALE: 'he-IL',
  DEEPDUB_EU: true,
  DEEPDUB_SAMPLE_RATE: 24_000,
  DEEPDUB_ACCENT_RATIO: 0.75,
} as unknown as Env;

describe('deepdubOptions — validation', () => {
  it('throws a clear error when the API key is missing', () => {
    expect(() => deepdubOptions({ ...baseEnv, DEEPDUB_API_KEY: undefined } as Env)).toThrow(
      /DEEPDUB_API_KEY/,
    );
  });

  it('throws when the voice prompt id is missing — you cannot synthesize without a voice', () => {
    expect(() => deepdubOptions({ ...baseEnv, DEEPDUB_VOICE_PROMPT_ID: undefined } as Env)).toThrow(
      /DEEPDUB_VOICE_PROMPT_ID/,
    );
  });

  it('maps every env field onto the options object', () => {
    expect(deepdubOptions(baseEnv)).toEqual({
      apiKey: 'dd-test-key',
      voicePromptId: 'voice-123',
      model: 'dd-etts-3.2',
      locale: 'he-IL',
      sampleRate: 24_000,
      realtime: true,
      eu: true,
      accentRatio: 0.75,
    });
  });
});

describe('DeepdubTTS — the LiveKit tts.TTS surface', () => {
  const tts = new DeepdubTTS(deepdubOptions(baseEnv));

  it('reports the configured sample rate and mono channel', () => {
    expect(tts.sampleRate).toBe(24_000);
    expect(tts.numChannels).toBe(1);
  });

  it('declares streaming capability — the pipeline only accepts streaming TTS', () => {
    expect(tts.capabilities.streaming).toBe(true);
  });

  it('exposes model and provider for metrics', () => {
    expect(tts.model).toBe('dd-etts-3.2');
    expect(tts.provider).toBe('deepdub');
  });
});

describe('deepdubCircuit — the breaker exists and is named', () => {
  it('is a deepdub-scoped breaker so a DeepDub outage cannot cascade', () => {
    expect(deepdubCircuit.name).toBe('deepdub');
    // starts closed (allowing calls) before any failures
    expect(deepdubCircuit.getState()).toBe('CLOSED');
  });
});
