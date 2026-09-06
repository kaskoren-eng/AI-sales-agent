import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from '../../../config/env.js';

/**
 * WHAT IS ACTUALLY RUNNING ON THIS CALL — read back from the live session, not from our hopes.
 *
 * WHY THIS EXISTS. The pipeline is configured in four different places (env defaults in
 * `config/env.ts`, `agent.config.ts`, `prewarm`, and `session.start`), and by the time a call is up
 * NOTHING said what the combination resolved to. That is not a cosmetic gap:
 *
 *   - `preemptiveTts` reads `env.VOICE_PREEMPTIVE_TTS`. The variable was set on the cloud agent and
 *     its value could not be recovered afterwards — `lk agent secrets` lists NAMES ONLY, nothing
 *     logged it, and the call report did not record it. So the single most consequential latency
 *     switch in the pipeline was in an unknown state in production, and the last measurement of it
 *     was taken while preemptive generation was broken (see agent.config.ts).
 *   - Turn detection is not simply `VOICE_TURN_DETECTION`. `AgentActivity` DOWNGRADES it to
 *     `undefined` at construction when the preconditions fail (no VAD, no STT, a RealtimeModel),
 *     logging a warning nobody reads. `resolved.turnDetection` below is that post-downgrade value.
 *   - 15 voice env keys are unset on the cloud agent and run on code defaults — including every
 *     kill-switch added in the last two days. `runningOnDefaults` names them, per call.
 *
 * The rule this module follows: a value is reported only if it was READ BACK from the thing that
 * owns it. Where that is impossible (the Silero VAD keeps its options in a `#private` field; the
 * noise-cancellation filter runs inside Rust and reports nothing), it says so instead of guessing.
 */

/** Whether a setting was chosen on this host, or fell through to the code default. */
export type EnvSource = 'env' | 'default';

export interface ConfiguredValue {
  value: string;
  source: EnvSource;
}

/**
 * What can be established about the agent-side noise filter.
 *
 * `engaged` is deliberately not a boolean. `TelephonyBackgroundVoiceCancellation()` returns a
 * plain `{ moduleId, options: { modelPath } }` descriptor; the filter itself is loaded by the
 * vendor package's module-level `load()`, which SWALLOWS a failure with a `console.error`, and is
 * applied inside `rtc-node`'s FFI layer (`newAudioStream` takes `audioFilterModuleId`). Neither
 * layer emits an event, a metric, or a callback saying "I am processing audio". So no honest code
 * can set this to true. See the handoff for what would be needed to actually prove it.
 */
export interface NoiseCancellationProbe {
  /** Which of the three models the agent asked for. */
  requested: string;
  moduleId: string | null;
  /** The .kef model file the descriptor points at. */
  modelPath: string | null;
  /**
   * The model file exists on disk. Note this is nearly tautological on a call that connected:
   * `modelPath()` THROWS when the file is missing, and it is called inside `session.start()`, so a
   * missing model kills the call rather than degrading it. Recorded anyway — it is the one link in
   * the chain we can check rather than assume.
   */
  modelFileExists: boolean | null;
  /**
   * The native plugin library sits in the SAME resources directory as the model. Its load failure
   * is the SILENT one: the vendor package catches it and prints to stderr at import time, long
   * before any call exists, and the descriptor still returns successfully afterwards.
   */
  pluginLibPath: string | null;
  pluginLibExists: boolean | null;
  /** The descriptor was actually handed to `session.start({ inputOptions })`. */
  attached: boolean;
  /** Always 'unprovable' — see the interface doc. Kept as a field so the report says so out loud. */
  engaged: 'unprovable';
  error?: string;
}

export interface PipelineSnapshot {
  /**
   * Read back off the live `AgentSession` AFTER `start()`, which is the only moment these are
   * true: the SDK merges defaults at construction and the activity re-resolves turn detection at
   * start. Null means the SDK moved the field and this instrument needs updating — never "off".
   */
  resolved: {
    turnDetection: string | null;
    endpointingMode: string | null;
    endpointingMinDelayMs: number | null;
    endpointingMaxDelayMs: number | null;
    preemptiveGeneration: boolean | null;
    preemptiveTts: boolean | null;
    preemptiveMaxSpeechDurationMs: number | null;
    preemptiveMaxRetries: number | null;
    interruptionEnabled: boolean | null;
    /**
     * SECONDS the caller may be silent before `user_state_changed -> 'away'` fires — i.e. before the
     * silence reflex is allowed to notice. Read back here because it is a SESSION-level default the
     * SDK merges in silently: it was 15 in production for the whole life of the agent, nobody had
     * chosen it, and it was invisible in every call report written before this field existed.
     * Null means the timer is off (or the SDK moved the field).
     */
    userAwayTimeoutSec: number | null;
    /** A VAD instance reached the activity. Proves `prewarm` ran and the ONNX model loaded. */
    vadAttached: boolean;
    /**
     * True would mean the SDK auto-provisioned its own VAD and OURS never arrived — i.e. every
     * `VOICE_VAD_*` setting below is fiction. Expected false.
     */
    vadIsSdkDefault: boolean | null;
    sttLabel: string | null;
    llmLabel: string | null;
    ttsLabel: string | null;
  };
  /**
   * What our own config asked for, and — the part that has been missing — whether each value was
   * SET on this host or came from a code default. Same effect either way; very different thing to
   * know when a production agent behaves unlike a laptop.
   */
  configured: Record<string, ConfiguredValue>;
  /** The subset of `configured` that is running on a code default. */
  runningOnDefaults: string[];
  noiseCancellation: NoiseCancellationProbe;
}

/**
 * The pipeline settings worth naming per call. API keys are deliberately absent — a call report is
 * read by humans and shipped to stdout.
 */
const PIPELINE_KEYS = [
  'STT_PROVIDER',
  'SONIOX_MODEL',
  'SONIOX_MAX_ENDPOINT_DELAY_MS',
  'OPENAI_REALTIME_MODEL',
  'VOICE_TURN_DETECTION',
  'VOICE_ENDPOINTING_MIN_DELAY_MS',
  'VOICE_ENDPOINTING_MAX_DELAY_MS',
  'VOICE_VAD_MIN_SILENCE_MS',
  'VOICE_VAD_ACTIVATION_THRESHOLD',
  'VOICE_PREEMPTIVE_TTS',
  'VOICE_PREEMPTIVE_PAUSE_MS',
  'AI_MODEL',
  'VOICE_LLM_MODEL',
  'VOICE_LLM_REASONING_EFFORT',
  'VOICE_LLM_SERVICE_TIER',
  'VOICE_MAX_HISTORY_ITEMS',
  'VOICE_TTS_PROVIDER',
  'VOICE_TTS_ROUTE',
  'CARTESIA_MODEL',
  // ADDED 2026-09-02. `CARTESIA_MODEL` was the only TTS model on this list, so a call served by
  // DeepDub or ElevenLabs wrote a report that named the provider and then named CARTESIA's model
  // beside it — and the listening harness, which reads the engine back out of this snapshot to
  // stamp it on every clip, could say "deepdub/" and nothing more. Neither key is a credential.
  'DEEPDUB_MODEL',
  'ELEVENLABS_MODEL',
  'VOICE_TTS_SPEED',
  'VOICE_TTS_VOLUME',
  'VOICE_LANGUAGE',
] as const satisfies readonly (keyof Env)[];

/**
 * Every switch that can change how she behaves, in one place.
 *
 * These are the ones that bite: they all default ON or OFF in code, so an agent with none of them
 * set is not "unconfigured" — it is running a specific configuration that nobody chose and nobody
 * can see. Listing them per call is the difference between reading a call report and guessing.
 */
const SWITCH_KEYS = [
  'VOICE_INSTANT_ACK',
  'VOICE_THINKING_FILLER_MS',
  'VOICE_HOLD_CHECKBACK_MS',
  'VOICE_SILENCE_AWAY_MS',
  'VOICE_RECORDING_NOTICE_ENABLED',
  'VOICE_AMD_ENABLED',
  'VOICE_STATE_MACHINE_ENABLED',
  'VOICE_SPEECH_NUMBERS_ENABLED',
  'VOICE_PHRASE_LEDGER_ENABLED',
  'VOICE_FACT_MEMORY_ENABLED',
  'VOICE_REGISTER_NUDGE_ENABLED',
  'VOICE_ACK_LEDGER_ENABLED',
  'VOICE_NEGATION_SAFETY',
  'VOICE_SPOKEN_REGISTER_ENABLED',
  'VOICE_EMAIL_DICTATION_ENABLED',
  // ADDED 2026-09-02, and both were already live before they were observable.
  //
  // `VOICE_SALES_MODEL_ENABLED` shipped to production on 2026-09-01 and was NOT on this list, so
  // the call report could not say whether the flag had reached the worker. I told Koren the report
  // would answer that question — "a flag explicitly set is absent from the running-on-defaults
  // list" — and the flag was simply not in the snapshot at all, which answers nothing.
  //
  // `VOICE_VOICE_MODES_ENABLED` and its factor are here from the start for the same reason, plus
  // one the A/B runner enforces: `assertPipelinesDiffer` refuses to believe a variant whose key it
  // cannot see in the report, so an unobserved flag cannot be A/B'd at all.
  'VOICE_SALES_MODEL_ENABLED',
  'VOICE_VOICE_MODES_ENABLED',
  'SHADOW_STT_ENABLED',
] as const satisfies readonly (keyof Env)[];

export const OBSERVED_ENV_KEYS: readonly (keyof Env)[] = [...PIPELINE_KEYS, ...SWITCH_KEYS];

/**
 * Was this key CHOSEN on this host, or is it a code default?
 *
 * `process.env` is the only place that knows. By the time `loadEnv()` has run, a Zod default and an
 * explicit value are indistinguishable — which is exactly the ambiguity that made
 * `VOICE_PREEMPTIVE_TTS` unanswerable in production. An empty string counts as unset: that is how
 * `envBool` and `z.coerce` treat it, and reporting it as "chosen" would be a lie in the other
 * direction.
 */
function sourceOf(key: string, processEnv: NodeJS.ProcessEnv): EnvSource {
  const raw = processEnv[key];
  return raw === undefined || raw === '' ? 'default' : 'env';
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null) return 'unset';
  if (typeof value === 'string') return value === '' ? 'unset' : value;
  return String(value);
}

/**
 * The minimum shape we need off the live session. Deliberately structural rather than importing
 * LiveKit's types: `AgentActivity.turnDetectionMode` is `private` in the SDK's own d.ts even though
 * it is the authoritative post-downgrade answer, so this has to be read through a cast either way.
 * Structural typing at least makes the cast say what it expects.
 */
export interface SessionLike {
  sessionOptions?: {
    userAwayTimeout?: unknown;
    turnHandling?: {
      turnDetection?: unknown;
      endpointing?: { mode?: unknown; minDelay?: unknown; maxDelay?: unknown };
      preemptiveGeneration?: {
        enabled?: unknown;
        preemptiveTts?: unknown;
        maxSpeechDuration?: unknown;
        maxRetries?: unknown;
      };
      interruption?: { enabled?: unknown };
    };
  };
  _activity?: {
    turnDetectionMode?: unknown;
    vad?: unknown;
    usingDefaultVad?: unknown;
    stt?: { label?: unknown } | undefined;
    llm?: { label?: unknown } | undefined;
    tts?: { label?: unknown } | undefined;
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A plugin's `label` is sometimes a getter, sometimes a method. Take whichever is there. */
function labelOf(component: { label?: unknown } | undefined | null): string | null {
  if (!component) return null;
  const { label } = component;
  if (typeof label === 'string') return label;
  if (typeof label === 'function') {
    try {
      return str((label as () => unknown).call(component));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Everything checkable about the noise filter, from the descriptor the agent actually passed.
 *
 * Takes the descriptor rather than importing `@livekit/noise-cancellation-node` itself: the vendor
 * package runs a native `load()` at import time, and an observability module must not be able to
 * change what loads or when.
 */
export function probeNoiseCancellation(
  requested: string,
  descriptor: unknown,
  attached: boolean,
): NoiseCancellationProbe {
  const base: NoiseCancellationProbe = {
    requested,
    moduleId: null,
    modelPath: null,
    modelFileExists: null,
    pluginLibPath: null,
    pluginLibExists: null,
    attached,
    engaged: 'unprovable',
  };
  try {
    const d = descriptor as { moduleId?: unknown; options?: { modelPath?: unknown } } | null;
    const moduleId = str(d?.moduleId);
    const modelPath = str(d?.options?.modelPath);
    if (!modelPath) return { ...base, moduleId, error: 'descriptor carried no modelPath' };

    // The plugin library lives beside the model — both come out of the platform package's
    // `resources/` directory (noise-cancellation-node: getResourceDir()).
    const ext =
      process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
    const pluginLibPath = join(dirname(modelPath), `liblivekit_nc_plugin${ext}`);
    return {
      ...base,
      moduleId,
      modelPath,
      modelFileExists: existsSync(modelPath),
      pluginLibPath,
      pluginLibExists: existsSync(pluginLibPath),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Builds the per-call snapshot. Call it AFTER `session.start()` — see `resolved`. */
export function describePipeline(args: {
  env: Env;
  session: SessionLike;
  noiseCancellation: NoiseCancellationProbe;
  processEnv?: NodeJS.ProcessEnv;
}): PipelineSnapshot {
  const { env, session, noiseCancellation } = args;
  const processEnv = args.processEnv ?? process.env;

  const turnHandling = session.sessionOptions?.turnHandling;
  const preemptive = turnHandling?.preemptiveGeneration;
  const endpointing = turnHandling?.endpointing;
  const activity = session._activity;

  const configured: Record<string, ConfiguredValue> = {};
  for (const key of OBSERVED_ENV_KEYS) {
    configured[key] = {
      value: describeValue((env as Record<string, unknown>)[key]),
      source: sourceOf(key, processEnv),
    };
  }

  return {
    resolved: {
      // The activity's own field first: it is the value AFTER the downgrade checks, and the
      // session option is only what was asked for. They differ exactly when something is wrong.
      turnDetection: str(activity?.turnDetectionMode) ?? str(turnHandling?.turnDetection),
      endpointingMode: str(endpointing?.mode),
      endpointingMinDelayMs: num(endpointing?.minDelay),
      endpointingMaxDelayMs: num(endpointing?.maxDelay),
      preemptiveGeneration: bool(preemptive?.enabled),
      preemptiveTts: bool(preemptive?.preemptiveTts),
      preemptiveMaxSpeechDurationMs: num(preemptive?.maxSpeechDuration),
      preemptiveMaxRetries: num(preemptive?.maxRetries),
      interruptionEnabled: bool(turnHandling?.interruption?.enabled),
      userAwayTimeoutSec: num(session.sessionOptions?.userAwayTimeout),
      vadAttached: activity?.vad != null,
      vadIsSdkDefault: bool(activity?.usingDefaultVad),
      sttLabel: labelOf(activity?.stt),
      llmLabel: labelOf(activity?.llm),
      ttsLabel: labelOf(activity?.tts),
    },
    configured,
    runningOnDefaults: Object.entries(configured)
      .filter(([, v]) => v.source === 'default')
      .map(([k]) => k),
    noiseCancellation,
  };
}

/** One line, greppable out of `lk agent logs`, in the same shape as the other agent log lines. */
export function formatPipelineLog(snapshot: PipelineSnapshot): string {
  return `pipeline_resolved ${JSON.stringify(snapshot)}`;
}

// ---------------------------------------------------------------------------------------------
// Preemptive counters
// ---------------------------------------------------------------------------------------------

/**
 * The EXACT strings LiveKit logs around a preemptive draft (agent_activity.js). They are the
 * contract; if the SDK reworks them these counters go to zero rather than lying, and
 * `draftsUnaccounted` below is what makes that visible.
 */
export const PREEMPTIVE_LOG_MESSAGES = {
  started: 'starting preemptive generation',
  used: 'using preemptive generation',
  invalidated: 'preemptive generation enabled but chat context or tools have changed',
} as const;

export interface PreemptiveCounters {
  generation: {
    /** `onPreemptiveGeneration` passed every gate and drafted a reply. */
    draftsStarted: number;
    /** The draft matched the committed transcript and context, and became the reply the caller heard. */
    draftsUsed: number;
    /** The draft was thrown away because the transcript or the context had changed under it. */
    draftsInvalidated: number;
    /**
     * Started, but neither used nor invalidated: `cancelPreemptiveGeneration()` dropped it with no
     * log line (a second draft superseding the first, or the activity being torn down). Also where
     * a renamed SDK message would show up.
     */
    draftsUnaccounted: number;
    /** How far ahead of the turn the winning drafts ran — the actual latency saved, per draft. */
    leadTimeMedianMs: number | null;
    leadTimeMaxMs: number | null;
  };
  /**
   * The same story told by the metrics stream instead of the log, and the reason `draftsDiscarded`
   * was ambiguous: `LLMMetrics.cancelled` is set from the generation's own abort signal, so it
   * counts the LLM calls we PAID FOR and never heard, whatever caused them.
   */
  llm: { completed: number; cancelled: number; cancelledPromptTokens: number };
  /**
   * TTS drafts. `TTSMetrics.cancelled` + `charactersCount` is the only direct measurement of what
   * preemptive TTS costs: the characters the ENGINE synthesized into a reply nobody heard.
   *
   * Engine-agnostic by construction — both fields are emitted by LiveKit's `SynthesizeStream`
   * base class (`charactersCount` is the input text's length), not by any plugin, so the count is
   * identical on the official Cartesia/ElevenLabs plugins and on our hand-written DeepDub adapter.
   * WHO IT BILLS is `pipeline.resolved.ttsLabel` on the same report — DeepDub by default since
   * 2026-09-02, and its per-character price has never been checked against an invoice, so this
   * counter is characters, not shekels.
   *
   * READ IT NEXT TO `pipeline.resolved.preemptiveTts`. With preemptive TTS OFF a cancelled
   * synthesis means a barge-in (the caller interrupted her); with it ON it also includes discarded
   * drafts. The counter cannot tell those apart — the switch state is what disambiguates it, which
   * is precisely why the switch state is now recorded on the same call.
   */
  tts: {
    completed: number;
    cancelled: number;
    charactersSynthesized: number;
    charactersDiscarded: number;
  };
}

/** Minimal pino surface. Only the three levels the preemptive messages use. */
type LoggerLike = Record<'info' | 'warn' | 'debug', (...args: unknown[]) => unknown>;

const LIVEKIT_LOGGER_KEY = Symbol.for('@livekit/agents:logger');

/** The global logger every `AgentActivity` holds (`logger = log()` is a class field). */
export function livekitLogger(): LoggerLike | null {
  const candidate = (globalThis as Record<symbol, unknown>)[LIVEKIT_LOGGER_KEY];
  if (!candidate || typeof candidate !== 'object') return null;
  const l = candidate as Partial<LoggerLike>;
  return typeof l.info === 'function' && typeof l.warn === 'function' && typeof l.debug === 'function'
    ? (candidate as LoggerLike)
    : null;
}

/** pino is called as `(msg)` or `(obj, msg)`. Pull the message out of either. */
function messageOf(args: unknown[]): string | null {
  if (typeof args[0] === 'string') return args[0];
  if (typeof args[1] === 'string') return args[1];
  return null;
}

/**
 * Counts what preemptive generation actually did on this call.
 *
 * WHY IT HOOKS THE LOGGER RATHER THAN INFERRING FROM TIMINGS. LiveKit emits no event for a draft
 * being started, used or discarded — the only signals are three log messages inside
 * `AgentActivity`, and one of them (`using preemptive generation`) is at DEBUG level, so it never
 * reaches a stream at the default log level. Watching the output stream would therefore have
 * counted starts and never uses, and "0 uses" would have been indistinguishable from "the feature
 * works". Wrapping the logger's methods intercepts the CALL, before pino's level filter, so the
 * count is correct at any log level while the printed output is byte-for-byte unchanged.
 *
 * This also fixes an instrument that has been silently dead: `CallReport` watches
 * `process.stderr.write` for LiveKit's cut-off warning, but the SDK's pino logger writes to
 * STDOUT (`log.js` — `pretty ? pinoPretty() : process.stdout`), so that warning could never have
 * been seen on either stream it was looked for. See the handoff.
 *
 * The wrapper delegates verbatim and is removed at teardown. Nothing here can change a decision.
 */
export class PreemptiveObserver {
  #started = 0;
  #used = 0;
  #invalidated = 0;
  #leadTimes: number[] = [];
  #llmCompleted = 0;
  #llmCancelled = 0;
  #llmCancelledPromptTokens = 0;
  #ttsCompleted = 0;
  #ttsCancelled = 0;
  #charactersSynthesized = 0;
  #charactersDiscarded = 0;
  #restore: (() => void) | null = null;

  /**
   * Wraps the LiveKit logger. Idempotent, and a no-op when the logger is absent (a unit test, or a
   * `console` run before `initializeLogger`) — losing a counter must never cost a call.
   */
  install(logger: LoggerLike | null = livekitLogger()): boolean {
    if (this.#restore || !logger) return false;
    const originals = {
      info: logger.info.bind(logger),
      warn: logger.warn.bind(logger),
      debug: logger.debug.bind(logger),
    };
    const wrap =
      (level: keyof typeof originals) =>
      (...args: unknown[]): unknown => {
        try {
          this.#note(messageOf(args), args[0]);
        } catch {
          // Counting must never break the log line itself.
        }
        return originals[level](...args);
      };
    logger.info = wrap('info');
    logger.warn = wrap('warn');
    logger.debug = wrap('debug');
    this.#restore = () => {
      logger.info = originals.info;
      logger.warn = originals.warn;
      logger.debug = originals.debug;
    };
    return true;
  }

  uninstall(): void {
    this.#restore?.();
    this.#restore = null;
  }

  #note(message: string | null, payload: unknown): void {
    if (!message) return;
    // startsWith, not equality: pino messages are stable but the SDK has appended detail to a
    // message before (the cut-off warning gained ", flushing vad").
    if (message.startsWith(PREEMPTIVE_LOG_MESSAGES.started)) {
      this.#started++;
      return;
    }
    if (message.startsWith(PREEMPTIVE_LOG_MESSAGES.used)) {
      this.#used++;
      const lead = (payload as { preemptiveLeadTime?: unknown } | null)?.preemptiveLeadTime;
      if (typeof lead === 'number' && Number.isFinite(lead) && lead >= 0) this.#leadTimes.push(lead);
      return;
    }
    if (message.startsWith(PREEMPTIVE_LOG_MESSAGES.invalidated)) this.#invalidated++;
  }

  /**
   * One metrics event, as the session emits it. Only `llm_metrics` and `tts_metrics` carry
   * `cancelled`; everything else is ignored.
   */
  noteMetrics(m: Record<string, unknown>): void {
    const type = m.type;
    const cancelled = m.cancelled === true;
    if (type === 'llm_metrics') {
      if (cancelled) {
        this.#llmCancelled++;
        if (typeof m.promptTokens === 'number') this.#llmCancelledPromptTokens += m.promptTokens;
      } else {
        this.#llmCompleted++;
      }
      return;
    }
    if (type === 'tts_metrics') {
      const chars = typeof m.charactersCount === 'number' ? m.charactersCount : 0;
      this.#charactersSynthesized += chars;
      if (cancelled) {
        this.#ttsCancelled++;
        this.#charactersDiscarded += chars;
      } else {
        this.#ttsCompleted++;
      }
    }
  }

  snapshot(): PreemptiveCounters {
    return {
      generation: {
        draftsStarted: this.#started,
        draftsUsed: this.#used,
        draftsInvalidated: this.#invalidated,
        draftsUnaccounted: Math.max(0, this.#started - this.#used - this.#invalidated),
        leadTimeMedianMs: median(this.#leadTimes),
        leadTimeMaxMs: this.#leadTimes.length ? Math.max(...this.#leadTimes) : null,
      },
      llm: {
        completed: this.#llmCompleted,
        cancelled: this.#llmCancelled,
        cancelledPromptTokens: this.#llmCancelledPromptTokens,
      },
      tts: {
        completed: this.#ttsCompleted,
        cancelled: this.#ttsCancelled,
        charactersSynthesized: this.#charactersSynthesized,
        charactersDiscarded: this.#charactersDiscarded,
      },
    };
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!);
}
