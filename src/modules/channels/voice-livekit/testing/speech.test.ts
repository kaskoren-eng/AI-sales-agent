import { describe, expect, it } from 'vitest';
import type { Env } from '../../../../config/env.js';
import { cartesiaOptions } from './speech.js';

const env = {
  CARTESIA_MODEL: 'sonic-3',
  CARTESIA_VOICE_ID_PRIMARY: 'env-voice-id',
  CARTESIA_API_KEY: 'sk_car_test',
  VOICE_LANGUAGE: 'he',
  VOICE_TTS_SPEED: 0.9,
  VOICE_TTS_VOLUME: 1.4,
} as unknown as Env;

describe('cartesiaOptions — the one-arg contract every bench harness depends on', () => {
  it('builds env-only options when called with one argument', () => {
    expect(cartesiaOptions(env)).toEqual({
      model: 'sonic-3',
      voice: 'env-voice-id',
      language: 'he',
      speed: 0.9,
      volume: 1.4,
      apiKey: 'sk_car_test',
    });
  });

  it('passes no emotion by default — silence is the pre-existing behaviour', () => {
    expect(cartesiaOptions(env).emotion).toBeUndefined();
  });

  it('omits apiKey when unset, leaving the plugin to read process.env', () => {
    const noKey = { ...env, CARTESIA_API_KEY: undefined } as unknown as Env;
    expect(cartesiaOptions(noKey)).not.toHaveProperty('apiKey');
  });
});

describe('cartesiaOptions — per-tenant overrides', () => {
  it('overrides voice, speed and volume; env fills the rest', () => {
    expect(cartesiaOptions(env, { voice: 'tenant-voice', speed: 1.1 })).toMatchObject({
      voice: 'tenant-voice',
      speed: 1.1,
      volume: 1.4, // untouched -> env
      language: 'he',
    });
  });

  /** The plugin's option is an array but only emotion[0] is sent — the array is a shape. */
  it('wraps a single emotion in the array the plugin expects', () => {
    expect(cartesiaOptions(env, { emotion: 'calm' }).emotion).toEqual(['calm']);
  });
});

/**
 * THE REGRESSION THIS FILE EXISTS FOR. The language gate used to be an exact-match Set that did
 * not contain 'sonic-3.5', so selecting that model silently dropped `language: 'he'` — the
 * documented sonic-turbo failure: fine in a one-shot WAV, mush on a live streamed call.
 */
describe('the language gate', () => {
  it.each(['sonic-3', 'sonic-3.5', 'sonic-3.5-2026-05-04', 'sonic-2', 'sonic', 'sonic-lite'])(
    'declares language on %s',
    (model) => {
      expect(cartesiaOptions({ ...env, CARTESIA_MODEL: model } as Env).language).toBe('he');
    },
  );

  it('does NOT declare language on sonic-turbo, which rejects it', () => {
    expect(cartesiaOptions({ ...env, CARTESIA_MODEL: 'sonic-turbo' } as Env)).not.toHaveProperty('language');
  });

  it('cannot be forced on by an override — the model has the last word', () => {
    const opts = cartesiaOptions({ ...env, CARTESIA_MODEL: 'sonic-turbo' } as Env, {
      voice: 'tenant-voice',
      speed: 1.1,
    });
    expect(opts).not.toHaveProperty('language');
    expect(opts.voice).toBe('tenant-voice');
  });
});
