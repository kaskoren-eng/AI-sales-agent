import { initializeLogger, log } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import {
  OBSERVED_ENV_KEYS,
  PREEMPTIVE_LOG_MESSAGES,
  PreemptiveObserver,
  type SessionLike,
  describePipeline,
  formatPipelineLog,
  livekitLogger,
  probeNoiseCancellation,
} from './pipeline-observer.js';
import type { Env } from '../../../config/env.js';

/**
 * The instrument that answers "is this pipeline actually connected", so it is pinned.
 *
 * Two of these tests exist because of specific ways an observability layer lies:
 *   - it reports what the code ASKED for and calls it what happened (the `preemptiveTts` hole:
 *     set as a cloud secret, unreadable, unlogged, unrecorded);
 *   - it reports a zero that means "nothing was wasted" when it actually means "nothing ever ran".
 */

const ENV = {
  STT_PROVIDER: 'soniox',
  SONIOX_MODEL: 'stt-rt-v5',
  VOICE_TURN_DETECTION: 'vad',
  VOICE_PREEMPTIVE_TTS: false,
  VOICE_VAD_MIN_SILENCE_MS: 250,
  VOICE_VAD_ACTIVATION_THRESHOLD: 0.5,
  AI_MODEL: 'gpt-5.4',
  CARTESIA_MODEL: 'sonic-3.5',
  VOICE_STATE_MACHINE_ENABLED: true,
} as unknown as Env;

/**
 * A session whose RESOLVED values deliberately disagree with the env above: turn detection was
 * asked for as 'vad' and the activity downgraded it, and preemptive TTS is on in the SDK while
 * `VOICE_PREEMPTIVE_TTS` reads false. If the snapshot ever quietly reports the env values, these
 * assertions break — which is the entire point of the fixture.
 */
const session: SessionLike = {
  sessionOptions: {
    turnHandling: {
      turnDetection: 'vad',
      endpointing: { mode: 'fixed', minDelay: 200, maxDelay: 2000 },
      preemptiveGeneration: {
        enabled: true,
        preemptiveTts: true,
        maxSpeechDuration: 10_000,
        maxRetries: 3,
      },
      interruption: { enabled: true },
    },
  },
  _activity: {
    turnDetectionMode: 'stt',
    vad: {},
    usingDefaultVad: false,
    stt: { label: 'soniox.STT' },
    llm: { label: () => 'openai.LLM' },
    tts: { label: 'cartesia.TTS' },
  },
};

const snapshotWith = (processEnv: NodeJS.ProcessEnv) =>
  describePipeline({
    env: ENV,
    session,
    noiseCancellation: probeNoiseCancellation('TelephonyBackgroundVoiceCancellation', null, false),
    processEnv,
  });

describe('describePipeline — resolved, not requested', () => {
  it('reports the ACTIVITY’s turn-detection mode, not the one env asked for', () => {
    // AgentActivity downgrades the mode at construction when its preconditions fail, logging a
    // warning nobody reads. That post-downgrade value is the one the caller experiences.
    expect(snapshotWith({}).resolved.turnDetection).toBe('stt');
  });

  it('reports preemptive TTS from the SDK options — the switch nobody could read in production', () => {
    const { resolved, configured } = snapshotWith({});
    expect(resolved.preemptiveTts).toBe(true);
    expect(resolved.preemptiveGeneration).toBe(true);
    // ...while the env value it was BUILT from says otherwise. Both are recorded, deliberately:
    // a disagreement here means something between env.ts and session.start changed the value.
    expect(configured.VOICE_PREEMPTIVE_TTS?.value).toBe('false');
  });

  it('carries the resolved endpointing window and the component labels', () => {
    const { resolved } = snapshotWith({});
    expect(resolved.endpointingMinDelayMs).toBe(200);
    expect(resolved.endpointingMaxDelayMs).toBe(2000);
    expect(resolved.sttLabel).toBe('soniox.STT');
    // `label` is a method on the LLM plugin and a property on the others.
    expect(resolved.llmLabel).toBe('openai.LLM');
    expect(resolved.ttsLabel).toBe('cartesia.TTS');
    expect(resolved.vadAttached).toBe(true);
    expect(resolved.vadIsSdkDefault).toBe(false);
  });

  it('returns nulls rather than guesses when the SDK moves a field', () => {
    // A future SDK rename must produce "we no longer know", never a confident default.
    const { resolved } = describePipeline({
      env: ENV,
      session: {},
      noiseCancellation: probeNoiseCancellation('x', null, false),
      processEnv: {},
    });
    expect(resolved.turnDetection).toBeNull();
    expect(resolved.preemptiveTts).toBeNull();
    expect(resolved.vadAttached).toBe(false);
  });
});

describe('describePipeline — env vs code default', () => {
  it('separates a value that was CHOSEN from one that fell through to a default', () => {
    const snap = snapshotWith({ VOICE_TURN_DETECTION: 'vad' });
    expect(snap.configured.VOICE_TURN_DETECTION).toEqual({ value: 'vad', source: 'env' });
    expect(snap.configured.VOICE_PREEMPTIVE_TTS?.source).toBe('default');
    expect(snap.runningOnDefaults).toContain('VOICE_PREEMPTIVE_TTS');
    expect(snap.runningOnDefaults).not.toContain('VOICE_TURN_DETECTION');
  });

  it('treats an empty string as unset — that is how envBool and z.coerce treat it', () => {
    expect(snapshotWith({ VOICE_TURN_DETECTION: '' }).configured.VOICE_TURN_DETECTION?.source).toBe(
      'default',
    );
  });

  it('names every kill-switch, so an unset one is visible instead of invisible', () => {
    const snap = snapshotWith({});
    for (const key of ['VOICE_PHRASE_LEDGER_ENABLED', 'VOICE_ACK_LEDGER_ENABLED', 'VOICE_AMD_ENABLED']) {
      expect(snap.configured[key]).toBeDefined();
    }
    // All 15+ of them run on code defaults when nothing is set — that is the production state the
    // supervisor audit found, and it should read as such rather than as silence.
    expect(snap.runningOnDefaults.length).toBe(OBSERVED_ENV_KEYS.length);
  });

  it('never puts a credential in the report', () => {
    for (const key of OBSERVED_ENV_KEYS) {
      expect(key).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/u);
    }
  });
});

describe('probeNoiseCancellation', () => {
  it('never claims the filter is engaged — no layer below it says so', () => {
    const probe = probeNoiseCancellation(
      'TelephonyBackgroundVoiceCancellation',
      { moduleId: 'livekit.plugins.noise_cancellation', options: { modelPath: '/nope/model.kef' } },
      true,
    );
    expect(probe.engaged).toBe('unprovable');
    expect(probe.attached).toBe(true);
    expect(probe.moduleId).toBe('livekit.plugins.noise_cancellation');
    expect(probe.modelFileExists).toBe(false);
    // The native plugin lives beside the model, so a missing resources dir shows up on both.
    expect(probe.pluginLibExists).toBe(false);
    expect(probe.pluginLibPath).toMatch(/liblivekit_nc_plugin\.(so|dll|dylib)$/u);
  });

  it('says so plainly when the descriptor carried nothing', () => {
    const probe = probeNoiseCancellation('x', null, false);
    expect(probe.modelPath).toBeNull();
    expect(probe.error).toMatch(/modelPath/u);
  });
});

describe('formatPipelineLog', () => {
  it('emits one greppable line whose payload round-trips', () => {
    const line = formatPipelineLog(snapshotWith({}));
    expect(line.startsWith('pipeline_resolved ')).toBe(true);
    expect(JSON.parse(line.slice('pipeline_resolved '.length)).resolved.turnDetection).toBe('stt');
  });
});

describe('PreemptiveObserver — proving the drafts fired', () => {
  const install = () => {
    const observer = new PreemptiveObserver();
    const calls: string[] = [];
    const logger = {
      info: (...a: unknown[]) => calls.push(`info:${String(a[1] ?? a[0])}`),
      warn: (...a: unknown[]) => calls.push(`warn:${String(a[1] ?? a[0])}`),
      debug: (...a: unknown[]) => calls.push(`debug:${String(a[1] ?? a[0])}`),
    };
    observer.install(logger);
    return { observer, logger, calls };
  };

  it('distinguishes "every draft was used" from "no draft was ever made"', () => {
    // The exact ambiguity in `draftsDiscarded: 0`, which reads identically for both.
    const dead = new PreemptiveObserver();
    expect(dead.snapshot().generation).toMatchObject({ draftsStarted: 0, draftsUsed: 0 });

    const { observer, logger } = install();
    logger.info({ newTranscript: 'שלום' }, PREEMPTIVE_LOG_MESSAGES.started);
    logger.debug({ preemptiveLeadTime: 400 }, PREEMPTIVE_LOG_MESSAGES.used);
    expect(observer.snapshot().generation).toMatchObject({ draftsStarted: 1, draftsUsed: 1 });
  });

  it('counts a draft the SDK invalidated, and its lead time when it survives', () => {
    const { observer, logger } = install();
    logger.info({}, PREEMPTIVE_LOG_MESSAGES.started);
    logger.info({}, PREEMPTIVE_LOG_MESSAGES.started);
    logger.debug({ preemptiveLeadTime: 300 }, PREEMPTIVE_LOG_MESSAGES.used);
    logger.warn(
      `${PREEMPTIVE_LOG_MESSAGES.invalidated} after \`onUserTurnCompleted\``,
    );
    const { generation } = observer.snapshot();
    expect(generation).toMatchObject({
      draftsStarted: 2,
      draftsUsed: 1,
      draftsInvalidated: 1,
      draftsUnaccounted: 0,
      leadTimeMedianMs: 300,
      leadTimeMaxMs: 300,
    });
  });

  it('surfaces a draft that vanished with no log line as unaccounted, not as a success', () => {
    // `cancelPreemptiveGeneration()` drops a superseded draft silently. So would a renamed SDK
    // message — which must show up as a hole rather than as "all drafts used".
    const { observer, logger } = install();
    logger.info({}, PREEMPTIVE_LOG_MESSAGES.started);
    logger.info({}, PREEMPTIVE_LOG_MESSAGES.started);
    expect(observer.snapshot().generation.draftsUnaccounted).toBe(2);
  });

  it('passes every log call through untouched', () => {
    const { observer, logger, calls } = install();
    logger.info({}, 'something unrelated');
    logger.info({}, PREEMPTIVE_LOG_MESSAGES.started);
    expect(calls).toEqual(['info:something unrelated', `info:${PREEMPTIVE_LOG_MESSAGES.started}`]);
    observer.uninstall();
    logger.info({}, PREEMPTIVE_LOG_MESSAGES.started);
    expect(observer.snapshot().generation.draftsStarted).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('counts wasted LLM and TTS work from the SDK’s own `cancelled` flag', () => {
    const observer = new PreemptiveObserver();
    observer.noteMetrics({ type: 'llm_metrics', cancelled: false, promptTokens: 3800 });
    observer.noteMetrics({ type: 'llm_metrics', cancelled: true, promptTokens: 3800 });
    observer.noteMetrics({ type: 'tts_metrics', cancelled: false, charactersCount: 120 });
    observer.noteMetrics({ type: 'tts_metrics', cancelled: true, charactersCount: 45 });
    observer.noteMetrics({ type: 'eou_metrics', cancelled: true });

    const snap = observer.snapshot();
    expect(snap.llm).toEqual({ completed: 1, cancelled: 1, cancelledPromptTokens: 3800 });
    // charactersDiscarded IS the bill for audio nobody heard, charged by whichever engine
    // VOICE_TTS_PROVIDER selected — the cost side of the
    // preemptive-TTS question, measured rather than argued.
    expect(snap.tts).toEqual({
      completed: 1,
      cancelled: 1,
      charactersSynthesized: 165,
      charactersDiscarded: 45,
    });
  });

  it('is a no-op when there is no logger to hook', () => {
    const observer = new PreemptiveObserver();
    expect(observer.install(null)).toBe(false);
    expect(() => observer.uninstall()).not.toThrow();
  });
});

describe('PreemptiveObserver against the REAL LiveKit logger', () => {
  /**
   * THE TEST THAT JUSTIFIES THE DESIGN. "using preemptive generation" is logged at DEBUG, and the
   * agent runs at level `info` — so pino discards it before it reaches any stream. Anything that
   * watched stdout would have counted starts, never uses, and reported a working feature as dead.
   * Wrapping the logger's methods intercepts the call ahead of the level filter.
   */
  it('counts the debug-level “used” message that is never printed', () => {
    initializeLogger({ pretty: false, level: 'info' });
    const logger = livekitLogger();
    expect(logger).not.toBeNull();
    expect(logger).toBe(log() as unknown as typeof logger);

    const observer = new PreemptiveObserver();
    expect(observer.install(logger)).toBe(true);
    try {
      logger!.debug({ preemptiveLeadTime: 512 }, PREEMPTIVE_LOG_MESSAGES.used);
      const { generation } = observer.snapshot();
      expect(generation.draftsUsed).toBe(1);
      expect(generation.leadTimeMedianMs).toBe(512);
    } finally {
      observer.uninstall();
    }
  });
});
