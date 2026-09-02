import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import {
  HarnessVoice,
  describeEngine,
  engineEnv,
  engineFromPipeline,
  engineSlug,
  parseEngineFlags,
  reframe,
} from './tts-engine.js';
import type { EngineOverride } from './tts-engine.js';
import type { PipelineSnapshot } from '../pipeline-observer.js';
import type { Env } from '../../../../config/env.js';

/**
 * The harness must speak the engine we ship, and every clip must say which engine that was.
 *
 * These tests exist because both failures are SILENT. A harness pinned to Cartesia after a flip to
 * DeepDub does not error — it produces perfectly good audio from an engine we no longer run. And a
 * WAV with no engine in its name does not error either; it just gets judged, months later, as
 * though it came from whatever engine the reader has in mind.
 */

const baseEnv = {
  VOICE_TTS_PROVIDER: 'cartesia',
  VOICE_TTS_ROUTE: 'cartesia',
  VOICE_TTS_SPEED: 0.85,
  VOICE_TTS_VOLUME: 1.4,
  CARTESIA_MODEL: 'sonic-3.5',
  CARTESIA_VOICE_ID_PRIMARY: 'cart-voice-1',
  DEEPDUB_MODEL: 'dd-etts-3.2',
  DEEPDUB_VOICE_PROMPT_ID: 'dd-voice-1',
  ELEVENLABS_MODEL: 'eleven_flash_v2_5',
  ELEVENLABS_VOICE_ID: 'el-voice-1',
} as unknown as Env;

const HERE = dirname(fileURLToPath(import.meta.url));

describe('describeEngine — follows VOICE_TTS_PROVIDER', () => {
  it('reports the configured engine when nothing is overridden', () => {
    const e = describeEngine(baseEnv);
    expect(e.provider).toBe('cartesia');
    expect(e.label).toBe('cartesia/sonic-3.5');
    expect(e.voice).toBe('cart-voice-1');
  });

  it('follows a flipped VOICE_TTS_PROVIDER without any code change', () => {
    const e = describeEngine({ ...baseEnv, VOICE_TTS_PROVIDER: 'deepdub' } as Env);
    expect(e.provider).toBe('deepdub');
    expect(e.model).toBe('dd-etts-3.2');
    expect(e.voice).toBe('dd-voice-1');
  });

  it('still allows an EXPLICIT override — the bench has to compare engines', () => {
    const e = describeEngine(baseEnv, { provider: 'deepdub' });
    expect(e.label).toBe('deepdub/dd-etts-3.2');
    // …and the override must not leak back into the caller's env.
    expect(describeEngine(baseEnv).provider).toBe('cartesia');
  });

  it('names the inference gateway, which is a different path with different defaults', () => {
    const e = describeEngine(baseEnv, { route: 'inference' });
    expect(e.label).toContain('inference');
    expect(e.slug).toContain('inference');
  });
});

describe('the speed/volume asymmetry is stated, never silently dropped', () => {
  it('says the levers are applied on Cartesia', () => {
    const e = describeEngine(baseEnv);
    expect(e.honoursSpeedVolume).toBe(true);
    expect(e.leverNote).toBeNull();
  });

  for (const provider of ['deepdub', 'elevenlabs'] as const) {
    it(`says out loud that ${provider} was sent NEITHER lever, and quotes their values`, () => {
      const e = describeEngine(baseEnv, { provider });
      expect(e.honoursSpeedVolume).toBe(false);
      // The note must carry the numbers, because a reader who cannot see what was asked for
      // cannot tell "ignored" from "applied and made no difference".
      expect(e.leverNote).toContain('0.85');
      expect(e.leverNote).toContain('1.4');
      expect(e.leverNote).toMatch(/CARTESIA-ONLY/u);
    });
  }

  it('never claims a non-Cartesia engine honours <break> tags', () => {
    expect(describeEngine(baseEnv).supportsPauseTags).toBe(true);
    expect(describeEngine(baseEnv, { provider: 'deepdub' }).supportsPauseTags).toBe(false);
  });
});

describe('engineEnv — an override rewrites the right keys for the right provider', () => {
  it('puts a model on the selected provider, not on Cartesia by habit', () => {
    const e = engineEnv(baseEnv, { provider: 'deepdub', model: 'dd-next' });
    expect(e.DEEPDUB_MODEL).toBe('dd-next');
    expect(e.CARTESIA_MODEL).toBe('sonic-3.5');
  });

  it('puts a voice on the selected provider', () => {
    const e = engineEnv(baseEnv, { provider: 'elevenlabs', voice: 'el-2' });
    expect(e.ELEVENLABS_VOICE_ID).toBe('el-2');
    expect(e.CARTESIA_VOICE_ID_PRIMARY).toBe('cart-voice-1');
  });

  it('applies a raw env patch last, so a bench arm can move anything', () => {
    const e = engineEnv(baseEnv, { provider: 'deepdub', env: { DEEPDUB_REALTIME: false } });
    expect(e.DEEPDUB_REALTIME).toBe(false);
  });
});

describe('engineFromPipeline — the engine is read off the AGENT, never assumed', () => {
  const snap = (configured: Record<string, string>): PipelineSnapshot =>
    ({
      resolved: { ttsLabel: 'cartesia.TTS' },
      configured: Object.fromEntries(
        Object.entries(configured).map(([k, v]) => [k, { value: v, source: 'env' }]),
      ),
      runningOnDefaults: [],
    }) as unknown as PipelineSnapshot;

  it('names provider and model together', () => {
    expect(
      engineFromPipeline(snap({ VOICE_TTS_PROVIDER: 'deepdub', DEEPDUB_MODEL: 'dd-etts-3.2' })),
    ).toBe('deepdub/dd-etts-3.2');
  });

  it('reads the CARTESIA model for a Cartesia call, not whatever key came first', () => {
    expect(
      engineFromPipeline(
        snap({ VOICE_TTS_PROVIDER: 'cartesia', CARTESIA_MODEL: 'sonic-3.5', DEEPDUB_MODEL: 'dd' }),
      ),
    ).toBe('cartesia/sonic-3.5');
  });

  it('returns null with NO report — an unverified clip must not be attributed to an engine', () => {
    expect(engineFromPipeline(null)).toBeNull();
    expect(engineSlug(null)).toBe('engine-unverified');
  });

  it('says the model is missing rather than inventing one', () => {
    expect(engineFromPipeline(snap({ VOICE_TTS_PROVIDER: 'deepdub' }))).toContain('not in report');
  });
});

describe('engineSlug — safe for a filename, and still readable', () => {
  it('keeps the provider and the model', () => {
    expect(engineSlug('deepdub/dd-etts-3.2')).toBe('deepdub_dd-etts-3.2');
  });

  it('strips everything a filesystem would object to', () => {
    expect(engineSlug('cartesia/sonic-3.5 (via inference gateway)')).toMatch(/^[\w.-]+$/u);
  });
});

describe('parseEngineFlags', () => {
  it('is undefined when nothing was asked for, so the tool measures the shipped engine', () => {
    expect(parseEngineFlags(['--anyway', 'sonic-3'])).toBeUndefined();
  });

  it('reads --engine / --model / --voice / --route', () => {
    expect(parseEngineFlags(['--engine=deepdub', '--model=dd-x', '--voice=v9'])).toEqual({
      provider: 'deepdub',
      model: 'dd-x',
      voice: 'v9',
    });
  });

  it('rejects an engine name that is not a real provider, instead of silently ignoring it', () => {
    // The whole point: a typo that applies cleanly and changes nothing produces two identical
    // clips labelled A and B — the failure the A/B runner already has a gate against.
    expect(() => parseEngineFlags(['--engine=deepdubb'])).toThrow(/not one of/u);
    expect(() => parseEngineFlags(['--route=grpc'])).toThrow(/not one of/u);
  });
});

describe('HarnessVoice — builds the engine the env names', () => {
  /**
   * Not a mock: this constructs the REAL adapter through production's `buildTTS`, which is the
   * whole claim being made. DeepDub's constructor only stores options (the socket pool is lazy),
   * so it costs nothing and touches no network.
   */
  it('a deepdub env produces a DeepDub TTS, and it says so itself', () => {
    const env = {
      ...baseEnv,
      VOICE_TTS_PROVIDER: 'deepdub',
      DEEPDUB_API_KEY: 'dd-test-key',
      DEEPDUB_REALTIME: true,
      DEEPDUB_LOCALE: 'he-IL',
      DEEPDUB_EU: true,
      DEEPDUB_SAMPLE_RATE: 24_000,
      DEEPDUB_ACCENT_RATIO: 0.75,
    } as unknown as Env;

    const voice = new HarnessVoice(env);
    expect(voice.engine.provider).toBe('deepdub');
    // The instance's OWN opinion, not ours — the anti-"we labelled it and built something else".
    expect(voice.tts.provider).toBe('deepdub');
    expect(voice.tts.model).toBe('dd-etts-3.2');
  });
});

describe('reframe — engines do not agree on a sample rate', () => {
  const frame = (samples: number, rate: number): AudioFrame =>
    new AudioFrame(new Int16Array(samples), rate, 1, samples);

  it('resamples 48kHz DeepDub output down to the caller’s 24kHz source', () => {
    // The bug this prevents is silent: publishing 48k frames into a 24k AudioSource does not
    // error, it plays the synthetic caller back at the wrong rate — which reads as a broken AGENT.
    const out = reframe([frame(4_800, 48_000)], 24_000);
    expect(out.every((f) => f.sampleRate === 24_000)).toBe(true);
    const total = out.reduce((n, f) => n + f.samplesPerChannel, 0);
    expect(total).toBe(2_400); // 100ms of audio, still 100ms
  });

  it('leaves a matching rate alone in duration, and frames it at 10ms', () => {
    const out = reframe([frame(2_400, 24_000)], 24_000);
    expect(out).toHaveLength(10);
    expect(out[0]!.samplesPerChannel).toBe(240);
  });
});

describe('no tool in testing/ may build its own Cartesia', () => {
  /**
   * THE ACTUAL REGRESSION GUARD. Everything above tests the new module; this tests that the old
   * habit did not survive somewhere. A single `new cartesia.TTS(...)` left in this folder is a
   * tool that goes on speaking Cartesia after the provider flips, silently.
   */
  it('constructs no TTS except through the shared builder', async () => {
    const offenders: string[] = [];
    for (const name of await readdir(HERE)) {
      if (!name.endsWith('.ts') || name === 'tts-engine.ts' || name.endsWith('.test.ts')) continue;
      const src = await readFile(join(HERE, name), 'utf8');
      if (/new\s+cartesia\.TTS\s*\(/u.test(src)) offenders.push(name);
      if (/new\s+DeepdubTTS\s*\(/u.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('resolves the engine through production’s own buildTTS, not a copy of the branch', async () => {
    const src = await readFile(join(HERE, 'tts-engine.ts'), 'utf8');
    expect(src).toMatch(/import \{ buildTTS \} from '\.\.\/agent\.config\.js'/u);
    // A re-implemented provider switch here is the drift this file exists to prevent.
    expect(src).not.toMatch(/new DeepdubTTS/u);
  });
});

describe('engineEnv — unknown override keys', () => {
  // Regression for 2026-09-02: a verification script wrote `{ engine: 'deepdub' }` instead of
  // `{ provider: 'deepdub' }`. tsx strips types without checking them, so the key vanished, both
  // arms ran on Cartesia, and the run read as a successful two-engine comparison. The audio looks
  // and sounds fine when this happens — which is exactly why it must throw.
  it('throws on a key EngineOverride does not have, rather than dropping it', () => {
    const env = baseEnv;
    expect(() => engineEnv(env, { engine: 'deepdub' } as unknown as EngineOverride)).toThrow(
      /unknown key\(s\): engine/,
    );
  });

  it('names the valid keys, so the typo is fixable from the message alone', () => {
    const env = baseEnv;
    expect(() => engineEnv(env, { modle: 'sonic-3.5' } as unknown as EngineOverride)).toThrow(
      /provider, model, voice, route, env/,
    );
  });

  it('still accepts every key the type declares', () => {
    const env = baseEnv;
    expect(() =>
      engineEnv(env, {
        provider: 'deepdub',
        model: 'dd-etts-3.2',
        voice: 'vp',
        route: 'cartesia',
        env: { DEEPDUB_REALTIME: false },
      }),
    ).not.toThrow();
  });
});
