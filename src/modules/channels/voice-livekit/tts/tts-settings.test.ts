import { describe, expect, it } from 'vitest';
import {
  CARTESIA_EMOTIONS,
  TENANT_SELECTABLE_MODELS,
  TTS_LIMITS,
  assertAgentPersona,
  resolveAgentPersona,
  supportsEmotion,
} from './tts-settings.js';

const ENV = { CARTESIA_MODEL: 'sonic-3' };

/** A fully-populated, fully-valid persona — the happy path every other case deviates from. */
const VALID = {
  name: 'קרן',
  gender: 'female',
  tts: { voiceId: 'HE_VOICE_ID', emotion: 'calm', speed: 0.85, volume: 1.4 },
};

describe('resolveAgentPersona — never throws, falls back per field', () => {
  it('returns pure defaults when the key is absent', () => {
    const r = resolveAgentPersona({ voice_engine: 'livekit' }, ENV);
    expect(r.overrides).toEqual({});
    expect(r.warnings).toEqual([]);
    expect(r.sources).toEqual({
      voice: 'default',
      model: 'default',
      emotion: 'default',
      speed: 'default',
      volume: 'default',
    });
    expect(r.persona).toEqual({ name: null, gender: null });
  });

  it('applies a fully valid persona', () => {
    const r = resolveAgentPersona({ agent_persona: VALID }, ENV);
    expect(r.overrides).toEqual({ voice: 'HE_VOICE_ID', emotion: 'calm', speed: 0.85, volume: 1.4 });
    // `model` stays 'default' — VALID does not set one, so the env model still speaks.
    expect(r.sources).toEqual({
      voice: 'tenant',
      model: 'default',
      emotion: 'tenant',
      speed: 'tenant',
      volume: 'tenant',
    });
    expect(r.warnings).toEqual([]);
    expect(r.persona).toEqual({ name: 'קרן', gender: 'female' });
  });

  /**
   * THE POINT OF PER-FIELD FALLBACK. One typo'd number must not cost the tenant their voice —
   * all-or-nothing would turn a bad character into a completely different-sounding agent.
   */
  it('keeps a good voiceId when speed is out of range', () => {
    const r = resolveAgentPersona(
      { agent_persona: { tts: { voiceId: 'HE_VOICE_ID', speed: 1.9 } } },
      ENV,
    );
    expect(r.overrides).toEqual({ voice: 'HE_VOICE_ID' });
    expect(r.sources.voice).toBe('tenant');
    expect(r.sources.speed).toBe('default');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('1.9');
  });

  it.each([
    ['speed below range', { speed: 0.5 }],
    ['speed above range', { speed: 1.6 }],
    ['volume below range', { volume: 0.4 }],
    ['volume above range', { volume: 2.1 }],
    ['speed as a string', { speed: '0.9' }],
    ['speed as NaN', { speed: Number.NaN }],
    ['volume as null', { volume: null }],
  ])('rejects %s and warns', (_label, tts) => {
    const r = resolveAgentPersona({ agent_persona: { tts } }, ENV);
    expect(r.overrides).toEqual({});
    expect(r.warnings).toHaveLength(1);
  });

  it('accepts the exact range boundaries', () => {
    const r = resolveAgentPersona(
      {
        agent_persona: {
          tts: { speed: TTS_LIMITS.speed.min, volume: TTS_LIMITS.volume.max },
        },
      },
      ENV,
    );
    expect(r.overrides).toEqual({ speed: 0.6, volume: 2.0 });
    expect(r.warnings).toEqual([]);
  });

  it.each(CARTESIA_EMOTIONS)('accepts the documented emotion %s', (emotion) => {
    const r = resolveAgentPersona({ agent_persona: { tts: { emotion } } }, ENV);
    expect(r.overrides.emotion).toBe(emotion);
    expect(r.warnings).toEqual([]);
  });

  /**
   * 'happy' and 'excited' are real Cartesia SSML words — they are NOT valid on the websocket's
   * generation_config, which is the path the agent uses. Passing them through would be "not
   * guaranteed" behaviour against a vendor whose rejection mode is silence.
   */
  it.each(['happy', 'excited', 'anger:high', ''])('rejects the non-websocket emotion %j', (emotion) => {
    const r = resolveAgentPersona({ agent_persona: { tts: { emotion } } }, ENV);
    expect(r.overrides.emotion).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
  });

  it('drops a valid emotion on a model that has no emotion control, and says so', () => {
    const r = resolveAgentPersona({ agent_persona: { tts: { emotion: 'calm' } } }, { CARTESIA_MODEL: 'sonic-2' });
    expect(r.overrides.emotion).toBeUndefined();
    expect(r.warnings[0]).toContain('sonic-2');
  });

  it('keeps emotion on sonic-3.5 (isSonic3 is a startsWith check)', () => {
    const r = resolveAgentPersona({ agent_persona: { tts: { emotion: 'calm' } } }, { CARTESIA_MODEL: 'sonic-3.5' });
    expect(r.overrides.emotion).toBe('calm');
    expect(r.warnings).toEqual([]);
  });

  it.each([
    ['null settings', null],
    ['a string', 'nope'],
    ['a number', 7],
    ['an array', []],
  ])('survives %s without throwing', (_label, settings) => {
    expect(() => resolveAgentPersona(settings, ENV)).not.toThrow();
    expect(resolveAgentPersona(settings, ENV).overrides).toEqual({});
  });

  it.each([
    ['agent_persona as an array', { agent_persona: [] }],
    ['agent_persona as a string', { agent_persona: 'קרן' }],
    ['tts as a string', { agent_persona: { tts: 'calm' } }],
  ])('warns on a malformed %s', (_label, settings) => {
    const r = resolveAgentPersona(settings, ENV);
    expect(r.overrides).toEqual({});
    expect(r.warnings).toHaveLength(1);
  });

  it('reads name and gender but ignores malformed ones', () => {
    const r = resolveAgentPersona({ agent_persona: { name: '  דניאל  ', gender: 'other' } }, ENV);
    expect(r.persona.name).toBe('דניאל');
    expect(r.persona.gender).toBeNull();
    expect(r.warnings).toHaveLength(1);
  });

  /** Warnings name the field, never the value's content — settings can hold PII-ish strings. */
  it('does not echo a long voice id into a warning', () => {
    const secretish = 'x'.repeat(200);
    const r = resolveAgentPersona({ agent_persona: { tts: { voiceId: 42, emotion: secretish } } }, ENV);
    for (const w of r.warnings) expect(w.length).toBeLessThan(200);
  });
});

describe('assertAgentPersona — throws on the write path', () => {
  it('normalizes and returns a valid persona', () => {
    expect(assertAgentPersona(VALID)).toEqual({
      name: 'קרן',
      gender: 'female',
      tts: { voiceId: 'HE_VOICE_ID', emotion: 'calm', speed: 0.85, volume: 1.4 },
    });
  });

  it('accepts an empty persona (every field optional)', () => {
    expect(assertAgentPersona({})).toEqual({ name: null, gender: null, tts: {} });
  });

  it.each([
    ['a non-object', 'nope'],
    ['a bad gender', { gender: 'other' }],
    ['an empty name', { name: '   ' }],
    ['a bad emotion', { tts: { emotion: 'happy' } }],
    ['speed above range', { tts: { speed: 1.6 } }],
    ['speed below range', { tts: { speed: 0.59 } }],
    ['volume above range', { tts: { volume: 2.01 } }],
    ['a string speed', { tts: { speed: '0.9' } }],
    ['an empty voiceId', { tts: { voiceId: '' } }],
    ['tts as an array', { tts: [] }],
  ])('throws on %s', (_label, input) => {
    expect(() => assertAgentPersona(input)).toThrow();
  });

  it('names the offending field and the legal range', () => {
    expect(() => assertAgentPersona({ tts: { volume: 9 } })).toThrow(/volume must be between 0.5 and 2/);
  });

  /**
   * THE ANTI-DRIFT INVARIANT. The two validators are written separately and could diverge — a
   * range widened in one and not the other would mean the API accepts a value that then silently
   * degrades to the env default on every call. Anything assert() accepts, resolve() must keep.
   */
  it('round-trips: whatever assert accepts, resolve keeps with no warnings', () => {
    const cases: unknown[] = [
      VALID,
      {},
      { name: 'דניאל', gender: 'male' },
      { tts: { speed: TTS_LIMITS.speed.min } },
      { tts: { speed: TTS_LIMITS.speed.max } },
      { tts: { volume: TTS_LIMITS.volume.min } },
      { tts: { volume: TTS_LIMITS.volume.max } },
      ...CARTESIA_EMOTIONS.map((emotion) => ({ tts: { emotion } })),
    ];
    for (const input of cases) {
      const persona = assertAgentPersona(input);
      const r = resolveAgentPersona({ agent_persona: persona }, ENV);
      expect(r.warnings, `warnings for ${JSON.stringify(input)}`).toEqual([]);
      if (persona.tts.speed !== undefined) expect(r.overrides.speed).toBe(persona.tts.speed);
      if (persona.tts.volume !== undefined) expect(r.overrides.volume).toBe(persona.tts.volume);
      if (persona.tts.emotion !== undefined) expect(r.overrides.emotion).toBe(persona.tts.emotion);
      if (persona.tts.voiceId !== undefined) expect(r.overrides.voice).toBe(persona.tts.voiceId);
    }
  });
});

/**
 * The model allowlist exists so sonic-3 vs sonic-3.5 can be A/B'd on real calls by flipping one DB
 * value — while making it impossible for a tenant to select a model that returns zero audio for
 * Hebrew and mutes their own agent.
 */
describe('the tenant model allowlist', () => {
  it.each(TENANT_SELECTABLE_MODELS)('accepts %s', (model) => {
    const r = resolveAgentPersona({ agent_persona: { tts: { model } } }, ENV);
    expect(r.overrides.model).toBe(model);
    expect(r.sources.model).toBe('tenant');
    expect(r.warnings).toEqual([]);
    expect(assertAgentPersona({ tts: { model } }).tts.model).toBe(model);
  });

  it.each(['sonic-turbo', 'sonic-2', 'sonic-lite', 'sonic', 'gpt-4o', ''])(
    'rejects %j — it would return zero Hebrew audio, silently',
    (model) => {
      const r = resolveAgentPersona({ agent_persona: { tts: { model } } }, ENV);
      expect(r.overrides.model).toBeUndefined();
      expect(r.warnings).toHaveLength(1);
      expect(() => assertAgentPersona({ tts: { model } })).toThrow(/model must be one of/);
    },
  );

  /** A rejected model must not take the rest of the persona down with it. */
  it('keeps voice and speed when the model is invalid', () => {
    const r = resolveAgentPersona(
      { agent_persona: { tts: { model: 'sonic-turbo', voiceId: 'HE_VOICE_ID', speed: 0.85 } } },
      ENV,
    );
    expect(r.overrides).toEqual({ voice: 'HE_VOICE_ID', speed: 0.85 });
  });

  /**
   * The emotion gate must ask about the model that will actually SPEAK. Gating on the env model
   * while sending the tenant's is the same class of silent mismatch as the language gate.
   */
  it('gates emotion on the tenant model, not the env model', () => {
    const r = resolveAgentPersona(
      { agent_persona: { tts: { model: 'sonic-3.5', emotion: 'calm' } } },
      { CARTESIA_MODEL: 'sonic-2' }, // env model has no emotion control; tenant's does
    );
    expect(r.overrides.emotion).toBe('calm');
    expect(r.warnings).toEqual([]);
  });
});

describe('supportsEmotion', () => {
  it.each([
    ['sonic-3', true],
    ['sonic-3.5', true],
    ['sonic-3.5-2026-05-04', true],
    ['sonic-2', false],
    ['sonic-turbo', false],
    ['sonic', false],
  ])('%s -> %s', (model, expected) => {
    expect(supportsEmotion(model)).toBe(expected);
  });
});
