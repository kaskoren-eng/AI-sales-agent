import { inference } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../config/env.js';
import { applyTenantTts } from './agent.config.js';
import { ensureLogger } from './testing/speech.js';
import { DeepdubTTS } from './tts/deepdub.tts.js';

// The LiveKit plugins log through a module-level pino the agent CLI normally initialises;
// constructing inference.TTS outside the CLI throws without this.
ensureLogger();

const env = {
  CARTESIA_MODEL: 'sonic-3',
  CARTESIA_VOICE_ID_PRIMARY: 'env-voice-id',
  CARTESIA_API_KEY: 'sk_car_test',
  VOICE_LANGUAGE: 'he',
  VOICE_TTS_SPEED: 0.9,
  VOICE_TTS_VOLUME: 1.4,
} as unknown as Env;

/** A real plugin instance so `instanceof` dispatch is exercised, with updateOptions spied. */
function cartesiaTts() {
  const tts = new cartesia.TTS({ apiKey: 'sk_car_test', voice: 'env-voice-id' });
  const spy = vi.spyOn(tts, 'updateOptions').mockImplementation(() => undefined);
  return { tts, spy };
}

function inferenceTts() {
  // The gateway route authenticates against LiveKit, not Cartesia — a dummy key is enough to
  // construct it; no request is made because updateOptions is stubbed.
  const tts = new inference.TTS({
    model: 'cartesia/sonic-3',
    voice: 'env-voice-id',
    apiKey: 'lk-test',
    apiSecret: 'lk-secret',
  });
  const spy = vi.spyOn(tts, 'updateOptions').mockImplementation(() => undefined);
  return { tts, spy };
}

describe('applyTenantTts — the direct Cartesia route', () => {
  it('forwards voice, speed and volume', () => {
    const { tts, spy } = cartesiaTts();
    expect(applyTenantTts(tts, { voice: 'tenant-voice', speed: 0.85, volume: 1.2 }, env)).toBe('applied');
    expect(spy).toHaveBeenCalledWith({ voice: 'tenant-voice', speed: 0.85, volume: 1.2 });
  });

  /** The plugin's option is an array and only emotion[0] is sent — a bare string would be wrong. */
  it('sends emotion as a single-element array', () => {
    const { tts, spy } = cartesiaTts();
    expect(applyTenantTts(tts, { emotion: 'calm' }, env)).toBe('applied');
    expect(spy).toHaveBeenCalledWith({ emotion: ['calm'] });
  });

  /** Absent fields must not be sent as undefined — that would overwrite a good env value. */
  it('sends only the fields the tenant actually set', () => {
    const { tts, spy } = cartesiaTts();
    applyTenantTts(tts, { speed: 1.1 }, env);
    expect(spy).toHaveBeenCalledWith({ speed: 1.1 });
  });
});

/**
 * The model swap is the whole point of the real-call A/B: one DB value, no redeploy. It must carry
 * `language` with it — the gate that decides whether to declare a language is per-model, and a
 * Hebrew stream with no declared language is the documented mush-on-a-live-call failure.
 */
describe('applyTenantTts — the model swap', () => {
  it('sends the model together with language', () => {
    const { tts, spy } = cartesiaTts();
    expect(applyTenantTts(tts, { model: 'sonic-3.5' }, env)).toBe('applied');
    expect(spy).toHaveBeenCalledWith({ model: 'sonic-3.5', language: 'he' });
  });

  it('namespaces the model by vendor on the inference route', () => {
    const { tts, spy } = inferenceTts();
    applyTenantTts(tts, { model: 'sonic-3.5' }, env);
    expect(spy.mock.calls[0]![0]).toMatchObject({ model: 'cartesia/sonic-3.5' });
  });

  it('carries the model alongside voice and prosody', () => {
    const { tts, spy } = cartesiaTts();
    applyTenantTts(tts, { model: 'sonic-3.5', voice: 'v-1', speed: 0.85 }, env);
    expect(spy).toHaveBeenCalledWith({ voice: 'v-1', model: 'sonic-3.5', language: 'he', speed: 0.85 });
  });
});

describe('applyTenantTts — the inference gateway route', () => {
  it('resends BOTH prosody levers because modelOptions is replaced wholesale', () => {
    const { tts, spy } = inferenceTts();
    // Only speed is overridden; volume must still be present, filled from env (1.4).
    expect(applyTenantTts(tts, { speed: 0.85 }, env)).toBe('applied');
    expect(spy).toHaveBeenCalledWith({ modelOptions: { speed: 0.85, volume: 1.4 } });
  });

  it('reports "partial" when emotion is requested, and does not send it', () => {
    const { tts, spy } = inferenceTts();
    expect(applyTenantTts(tts, { emotion: 'calm', speed: 0.85 }, env)).toBe('partial');
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('calm');
  });
});

describe('applyTenantTts — providers it cannot speak for', () => {
  it('reports "unsupported" for DeepDub and changes nothing', () => {
    const tts = new DeepdubTTS({
      apiKey: 'k',
      voicePromptId: 'v',
      model: 'dd-etts-2.5',
      locale: 'he-IL',
      sampleRate: 48_000,
      realtime: true,
      eu: false,
      accentRatio: 1,
    });
    expect(applyTenantTts(tts, { voice: 'a-cartesia-voice-id', speed: 0.85 }, env)).toBe('unsupported');
  });

  it('reports "noop" and never calls updateOptions when there is nothing to apply', () => {
    const { tts, spy } = cartesiaTts();
    expect(applyTenantTts(tts, {}, env)).toBe('noop');
    expect(spy).not.toHaveBeenCalled();
  });
});
