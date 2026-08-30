import { describe, expect, it } from 'vitest';
import type { PipelineSnapshot } from '../pipeline-observer.js';
import {
  assertPipelinesDiffer,
  assertVariantsDiffer,
  unknownEnvKeys,
  variantKeys,
} from './variants.js';
import { parseOverlay } from './env-overlay.js';

const snapshot = (configured: Record<string, string>): PipelineSnapshot =>
  ({
    configured: Object.fromEntries(
      Object.entries(configured).map(([k, v]) => [k, { value: v, source: 'env' as const }]),
    ),
  }) as unknown as PipelineSnapshot;

describe('assertVariantsDiffer', () => {
  it('refuses two variants with the same overrides — they would be A vs A', () => {
    expect(() =>
      assertVariantsDiffer([
        { key: 'A', label: 'a', env: { VOICE_TTS_SPEED: '0.9' } },
        { key: 'B', label: 'b', env: { VOICE_TTS_SPEED: '0.9' } },
      ]),
    ).toThrow(/IDENTICAL env overrides/u);
  });

  it('ignores key order when comparing', () => {
    expect(() =>
      assertVariantsDiffer([
        { key: 'A', label: 'a', env: { X: '1', Y: '2' } },
        { key: 'B', label: 'b', env: { Y: '2', X: '1' } },
      ]),
    ).toThrow(/IDENTICAL/u);
  });

  it('allows a real difference, and a single variant', () => {
    expect(() =>
      assertVariantsDiffer([
        { key: 'A', label: 'baseline', env: {} },
        { key: 'B', label: 'slower', env: { VOICE_TTS_SPEED: '0.85' } },
      ]),
    ).not.toThrow();
    expect(() => assertVariantsDiffer([{ key: 'A', label: 'only', env: {} }])).not.toThrow();
  });
});

describe('unknownEnvKeys', () => {
  it('accepts the real schema keys — including the two missing from .env.example', () => {
    // These are exactly the keys the first version of this check wrongly rejected, because it
    // validated against .env.example instead of the schema.
    expect(unknownEnvKeys(['VOICE_TTS_SPEED', 'VOICE_TTS_VOLUME', 'AI_MODEL'])).toEqual([]);
  });

  it('catches the typo that would apply cleanly and change nothing', () => {
    expect(unknownEnvKeys(['VOICE_TTS_SPEEED'])).toEqual(['VOICE_TTS_SPEEED']);
  });
});

describe('assertPipelinesDiffer — the post-run proof', () => {
  const declared = ['VOICE_TTS_SPEED'];

  it('flags a variant whose override the agent did NOT run', () => {
    const warnings = assertPipelinesDiffer(
      [
        { key: 'A', overrides: {}, pipeline: snapshot({ VOICE_TTS_SPEED: '1' }) },
        { key: 'B', overrides: { VOICE_TTS_SPEED: '0.85' }, pipeline: snapshot({ VOICE_TTS_SPEED: '1' }) },
      ],
      declared,
    );
    expect(warnings.filter((w) => w.startsWith('IDENTICAL'))).not.toHaveLength(0);
    expect(warnings[0]).toContain('did not take effect');
  });

  it('stays silent when the agent really did run the declared values', () => {
    expect(
      assertPipelinesDiffer(
        [
          { key: 'A', overrides: {}, pipeline: snapshot({ VOICE_TTS_SPEED: '1' }) },
          {
            key: 'B',
            overrides: { VOICE_TTS_SPEED: '0.85' },
            pipeline: snapshot({ VOICE_TTS_SPEED: '0.85' }),
          },
        ],
        declared,
      ),
    ).toEqual([]);
  });

  it('says "unproven", not "fine", when a call report is missing', () => {
    const warnings = assertPipelinesDiffer(
      [
        { key: 'A', overrides: { VOICE_TTS_SPEED: '1' }, pipeline: null },
        { key: 'B', overrides: { VOICE_TTS_SPEED: '0.85' }, pipeline: snapshot({ VOICE_TTS_SPEED: '0.85' }) },
      ],
      declared,
    );
    expect(warnings.some((w) => w.includes('could NOT be verified'))).toBe(true);
  });

  it('does NOT cry wolf when a variant sets a key to the value .env already had', () => {
    // The false alarm the first version produced on the very first real run: variant B declared
    // VOICE_TTS_VOLUME=1.4 and .env already said 1.4, so both calls reported 1.4 — correctly.
    expect(
      assertPipelinesDiffer(
        [
          { key: 'A', overrides: {}, pipeline: snapshot({ VOICE_TTS_VOLUME: '1.4', X: '1' }) },
          {
            key: 'B',
            overrides: { VOICE_TTS_VOLUME: '1.4' },
            pipeline: snapshot({ VOICE_TTS_VOLUME: '1.4', X: '2' }),
          },
        ],
        ['VOICE_TTS_VOLUME', 'X'],
      ),
    ).toEqual([]);
  });

  it('flags a run where every variant resolved to the same thing', () => {
    const warnings = assertPipelinesDiffer(
      [
        { key: 'A', overrides: {}, pipeline: snapshot({ VOICE_TTS_SPEED: '1' }) },
        { key: 'B', overrides: {}, pipeline: snapshot({ VOICE_TTS_SPEED: '1' }) },
      ],
      declared,
    );
    expect(warnings.some((w) => w.includes('nothing being compared'))).toBe(true);
  });
});

describe('variantKeys', () => {
  it('unions and sorts every key any variant mentions', () => {
    expect(
      variantKeys([
        { key: 'A', label: 'a', env: { B: '1' } },
        { key: 'B', label: 'b', env: { A: '1', B: '2' } },
      ]),
    ).toEqual(['A', 'B']);
  });
});

describe('parseOverlay', () => {
  it('stringifies numbers and booleans so the obvious JSON works', () => {
    expect(parseOverlay('{"VOICE_TTS_SPEED":0.85,"VOICE_INSTANT_ACK":false}', 'x')).toEqual({
      VOICE_TTS_SPEED: '0.85',
      VOICE_INSTANT_ACK: 'false',
    });
  });

  it('refuses a key that could never be an env var, rather than silently no-opping', () => {
    expect(() => parseOverlay('{"voiceTtsSpeed":"0.85"}', 'x')).toThrow(/not a valid env var name/u);
  });

  it('refuses anything that is not a flat object', () => {
    expect(() => parseOverlay('[]', 'x')).toThrow(/must be a JSON object/u);
    expect(() => parseOverlay('{"A":{"b":1}}', 'x')).toThrow(/must be a string, number or boolean/u);
    expect(() => parseOverlay('not json', 'x')).toThrow(/not valid JSON/u);
  });
});
