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

  it('reports the protocol-native 48kHz rate and mono channel', () => {
    // The per-generation WS protocol is WAV-only at the model's native 48kHz — the sampleRate
    // option is NOT honored there (the streaming protocol honored it; we left that protocol for
    // the EU endpoint + exact isFinished, see the adapter header). LiveKit resamples downstream.
    expect(tts.sampleRate).toBe(48_000);
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

/**
 * THE FIXED-LINE AUDIO CACHE, at the only boundary that matters: `generate()`.
 *
 * The unit tests for eligibility live in fixed-line-audio.test.ts. These prove the two things that
 * can only be seen from inside the adapter — that a hit reaches the caller without a vendor round
 * trip at all, and that anything not on the allowlist still goes to the vendor exactly as before.
 */
describe('DeepdubTTS — serving a fixed line from memory', () => {
  const cachedEnv = { ...baseEnv, VOICE_TTS_AUDIO_CACHE: true } as unknown as Env;

  it('attaches a cache only when the flag is on', () => {
    expect(deepdubOptions(baseEnv).audioCache).toBeUndefined();
    expect(deepdubOptions(cachedEnv).audioCache).toBeDefined();
  });

  it('serves a stored line without touching the network', async () => {
    const opts = deepdubOptions(cachedEnv);
    const cache = opts.audioCache!;
    const key = cache.keyFor(opts.voicePromptId, 'בסדר.')!;
    cache.put(key, [Buffer.from([1, 2]), Buffer.from([3, 4])]);

    const got: Buffer[] = [];
    // There is no socket in a unit test, so reaching the vendor would REJECT. Resolving is the
    // proof that nothing was dialed — and that is the entire saving: no request, no first byte.
    await new DeepdubTTS(opts).generate('בסדר.', (pcm) => got.push(pcm), () => false);

    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('stops mid-playback when the turn is cancelled', async () => {
    const opts = deepdubOptions(cachedEnv);
    const cache = opts.audioCache!;
    const key = cache.keyFor(opts.voicePromptId, 'בסדר.')!;
    cache.put(key, [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])]);

    const got: Buffer[] = [];
    let cancelled = false;
    await new DeepdubTTS(opts).generate(
      'בסדר.',
      (pcm) => {
        got.push(pcm);
        cancelled = true; // the caller barged in after the first chunk
      },
      () => cancelled,
    );
    expect(got).toHaveLength(1);
  });

  it('cannot serve anything the model wrote, whatever is in the cache', () => {
    const opts = deepdubOptions(cachedEnv);
    // Asserted at the KEY rather than by calling generate(): generate() on ineligible text would
    // dial DeepDub, and a unit suite that reaches the network is slow and flaky offline — the
    // first version of this case measured 737ms and a real 403. A null key is the same guarantee,
    // because with no key there is no cache branch to take, and it costs nothing.
    expect(opts.audioCache!.keyFor(opts.voicePromptId, 'אנחנו עוזרים לעסקים.')).toBeNull();
    expect(opts.audioCache!.keyFor(opts.voicePromptId, 'עמית')).toBeNull();
  });
});
