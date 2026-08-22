import { describe, it, expect } from 'vitest';
import { cartesiaOptions } from './speech.js';
import type { Env } from '../../../../config/env.js';

/**
 * THE BUG THESE EXIST FOR.
 *
 * `cartesiaOptions` passes `language` only for models in an allow-list, because the older Sonic
 * models 400 on the field. `sonic-3.5` became the configured default on 2026-08-05 and was never
 * added to that list — so `language: 'he'` was silently dropped on every call for two and a half
 * weeks, in production as well as locally, and Cartesia voiced Hebrew text with English phonetics.
 *
 * Koren, on a real call, 2026-08-22: "she don't speak hebrew".
 *
 * Nothing failed. 434 voice tests passed throughout, because no test asserted that the model we
 * actually ship gets a language. A silent omission needs a test that fails on silence.
 *
 * Probed against the live API before fixing it, so the allow-list entry is a measured fact:
 *
 *     sonic-3.5 WITH language=he     200   184,398 bytes
 *     sonic-3.5 WITHOUT language     200   195,918 bytes
 */

const env = (over: Partial<Env> = {}): Env =>
  ({
    CARTESIA_MODEL: 'sonic-3.5',
    CARTESIA_VOICE_ID_PRIMARY: 'voice-id',
    VOICE_LANGUAGE: 'he',
    VOICE_TTS_SPEED: 0.9,
    VOICE_TTS_VOLUME: 1.4,
    ...over,
  }) as unknown as Env;

describe('cartesiaOptions — the language parameter', () => {
  /**
   * The load-bearing assertion. It reads CARTESIA_MODEL's own default rather than hardcoding a
   * model name, so changing the default without updating the allow-list fails HERE — which is the
   * only way this class of bug gets caught before a caller hears it.
   */
  it('sends a language for the model we actually ship', async () => {
    const { loadEnv } = await import('../../../../config/env.js');
    const shipped = loadEnv().CARTESIA_MODEL;
    expect(
      cartesiaOptions(env({ CARTESIA_MODEL: shipped })).language,
      `CARTESIA_MODEL is "${shipped}" but cartesiaOptions drops language for it — Hebrew will be ` +
        'voiced with the wrong phonetics. Add it to MODELS_ACCEPTING_LANGUAGE in speech.ts.',
    ).toBe('he');
  });

  it('sends the language for sonic-3.5 specifically', () => {
    expect(cartesiaOptions(env({ CARTESIA_MODEL: 'sonic-3.5' })).language).toBe('he');
  });

  it('still sends it for the older models that accept it', () => {
    for (const model of ['sonic-3', 'sonic-2', 'sonic', 'sonic-lite']) {
      expect(cartesiaOptions(env({ CARTESIA_MODEL: model })).language, model).toBe('he');
    }
  });

  /** The allow-list is not decoration: a model we have not verified must be called without it. */
  it('omits it for a model that is not on the list', () => {
    expect(cartesiaOptions(env({ CARTESIA_MODEL: 'sonic-turbo-99' })).language).toBeUndefined();
  });

  it('carries the 8kHz intelligibility levers through unchanged', () => {
    // Tuned by ear on a real phone call; a language fix must not quietly reset them.
    const opts = cartesiaOptions(env());
    expect(opts.speed).toBe(0.9);
    expect(opts.volume).toBe(1.4);
    expect(opts.voice).toBe('voice-id');
  });
});
