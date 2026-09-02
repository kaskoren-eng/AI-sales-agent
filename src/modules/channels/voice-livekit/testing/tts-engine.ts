/**
 * THE ONE PLACE THE HARNESS BUILDS A TTS.
 *
 * Before this file, every local tool constructed `new cartesia.TTS(...)` by hand. That was
 * harmless only for as long as Cartesia was also what production spoke. Koren decided on
 * 2026-09-02 to move TTS to DeepDub — and on that day every A/B page, every clarity sample and
 * every synthetic caller in this folder would have gone on speaking CARTESIA while the agent spoke
 * DEEPDUB, silently, with nothing on the page to say so. That is the same class of failure as the
 * 2026-08-16 language-parameter incident: not an error, not a warning, just a measurement of
 * something we do not ship.
 *
 * So the harness resolves its engine the way production resolves it — through `VOICE_TTS_PROVIDER`
 * — and it does it by calling production's OWN `buildTTS()` rather than by re-implementing the
 * branch. A re-implementation is a copy that drifts; a call cannot.
 *
 * WHAT IS DELIBERATELY NOT AUTOMATIC: the `override` argument. `npm run bench:tts` exists to put
 * engines head to head, and an instrument that can only ever measure the configured engine cannot
 * do that. So an explicit override is always available — and whatever it resolves to is stamped
 * onto the filename and onto the page, because a clip whose engine is not on its face is a verdict
 * waiting to be misattributed to the wrong voice.
 *
 * THE SPEED/VOLUME ASYMMETRY, STATED RATHER THAN HIDDEN. `VOICE_TTS_SPEED` and `VOICE_TTS_VOLUME`
 * are CARTESIA-ONLY — the DeepDub adapter sends neither, and the ElevenLabs path does not carry
 * them either. They are not cosmetics: they are the intelligibility levers tuned by ear for the
 * 8kHz phone band (see `cartesiaOptions` in speech.ts). A bench that quietly ignored them would
 * invite exactly one wrong conclusion — "those knobs make no difference" — so every descriptor
 * here carries `leverNote`, and every tool that renders a clip is expected to show it.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { tts as ttsBase } from '@livekit/agents';
import { buildTTS } from '../agent.config.js';
import { pausesSupported } from '../voice-mode.js';
import { ensureLogger } from './speech.js';
import { concatFrames, resamplePcm } from './wav.js';
import type { PipelineSnapshot } from '../pipeline-observer.js';
import type { Env } from '../../../../config/env.js';

/** The engines `VOICE_TTS_PROVIDER` accepts. Kept in step with `src/config/env.ts` by the type. */
export type EngineName = Env['VOICE_TTS_PROVIDER'];

export const ENGINE_NAMES = [
  'cartesia',
  'deepdub',
  'elevenlabs',
] as const satisfies readonly EngineName[];

/**
 * An explicit engine choice, for the tools whose whole job is comparison.
 *
 * Everything is optional and everything defaults to what `VOICE_TTS_PROVIDER` already resolves to,
 * so a tool that passes nothing measures the shipped engine — which is what a tool should do
 * unless it was written to compare.
 */
export interface EngineOverride {
  provider?: EngineName;
  /** Swaps the model of whichever provider ends up selected (CARTESIA_MODEL / DEEPDUB_MODEL / …). */
  model?: string;
  /** Swaps the voice id / voice prompt id of whichever provider ends up selected. */
  voice?: string;
  /** Cartesia only: direct to Cartesia, or through the LiveKit inference gateway. */
  route?: Env['VOICE_TTS_ROUTE'];
  /** Anything else a bench arm needs to move (e.g. DEEPDUB_REALTIME). Applied last. */
  env?: Partial<Env>;
}

export interface EngineDescriptor {
  provider: EngineName;
  /** `sonic-3.5`, `dd-etts-3.2`, `eleven_flash_v2_5`. */
  model: string;
  /** Voice id / voice prompt id. Undefined when none is configured — which is itself a finding. */
  voice: string | undefined;
  /** Cartesia only; null for every other engine. */
  route: Env['VOICE_TTS_ROUTE'] | null;
  /** `deepdub/dd-etts-3.2` — what a human reads on the page and in a verdict. */
  label: string;
  /** `deepdub_dd-etts-3.2` — what goes in a FILENAME, so a stray WAV still names its engine. */
  slug: string;
  /** Whether this engine honours VOICE_TTS_SPEED / VOICE_TTS_VOLUME at all. */
  honoursSpeedVolume: boolean;
  speed: number;
  volume: number;
  /** Whether `<break time="…"/>` is honoured rather than SPOKEN ALOUD. Cartesia only. */
  supportsPauseTags: boolean;
  /**
   * Null when the engine honours the levers. Otherwise the sentence a reader must see before
   * concluding anything about speed or volume from this clip.
   */
  leverNote: string | null;
}

/** Everything a filename may contain. Anything else becomes `_`. */
function slugify(s: string): string {
  return s.replace(/[^a-z0-9.-]+/giu, '_').replace(/^_+|_+$/gu, '');
}

/**
 * The Env this engine choice actually runs under.
 *
 * A synthetic Env rather than a set of options, because `buildTTS()` reads env and nothing else —
 * so overriding the env is the only way to reach it that cannot fall out of step with what the
 * agent does on a real call.
 */
export function engineEnv(env: Env, override?: EngineOverride): Env {
  if (!override) return env;
  const provider = override.provider ?? env.VOICE_TTS_PROVIDER;
  let next: Env = { ...env, VOICE_TTS_PROVIDER: provider };
  if (override.route) next = { ...next, VOICE_TTS_ROUTE: override.route };
  if (override.model !== undefined) {
    next =
      provider === 'deepdub'
        ? { ...next, DEEPDUB_MODEL: override.model }
        : provider === 'elevenlabs'
          ? { ...next, ELEVENLABS_MODEL: override.model }
          : { ...next, CARTESIA_MODEL: override.model };
  }
  if (override.voice !== undefined) {
    next =
      provider === 'deepdub'
        ? { ...next, DEEPDUB_VOICE_PROMPT_ID: override.voice }
        : provider === 'elevenlabs'
          ? { ...next, ELEVENLABS_VOICE_ID: override.voice }
          : { ...next, CARTESIA_VOICE_ID_PRIMARY: override.voice };
  }
  return override.env ? { ...next, ...override.env } : next;
}

/** What this env (plus any override) will actually speak with, in the form a human can read. */
export function describeEngine(env: Env, override?: EngineOverride): EngineDescriptor {
  const e = engineEnv(env, override);
  const provider = e.VOICE_TTS_PROVIDER;
  const honoursSpeedVolume = provider === 'cartesia';

  const model =
    provider === 'deepdub'
      ? e.DEEPDUB_MODEL
      : provider === 'elevenlabs'
        ? e.ELEVENLABS_MODEL
        : e.CARTESIA_MODEL;
  const voice =
    provider === 'deepdub'
      ? e.DEEPDUB_VOICE_PROMPT_ID
      : provider === 'elevenlabs'
        ? e.ELEVENLABS_VOICE_ID
        : e.CARTESIA_VOICE_ID_PRIMARY;
  const route = provider === 'cartesia' ? e.VOICE_TTS_ROUTE : null;

  const label = `${provider}/${model}` + (route === 'inference' ? ' (via inference gateway)' : '');

  return {
    provider,
    model,
    voice,
    route,
    label,
    slug: slugify(`${provider}_${model}${route === 'inference' ? '_inference' : ''}`),
    honoursSpeedVolume,
    speed: e.VOICE_TTS_SPEED,
    volume: e.VOICE_TTS_VOLUME,
    supportsPauseTags: pausesSupported(provider),
    leverNote: honoursSpeedVolume
      ? null
      : `VOICE_TTS_SPEED=${e.VOICE_TTS_SPEED} and VOICE_TTS_VOLUME=${e.VOICE_TTS_VOLUME} are ` +
        `CARTESIA-ONLY and were NOT applied — ${provider} was sent neither. This clip is at the ` +
        `engine's own rate and level, so nothing here says anything about those two levers.`,
  };
}

/**
 * One TTS, held open across many syntheses — the way a real call holds one for the whole call.
 *
 * Building a fresh engine per sentence measures TCP + TLS + websocket handshake every time (it put
 * the Cartesia baseline at 1411ms against 455ms on a real call), and on DeepDub it also leaks a
 * socket per sentence out of a two-socket pool. So the harness leases one and closes it.
 */
export class HarnessVoice {
  readonly engine: EngineDescriptor;
  readonly #tts: ttsBase.TTS;
  #closed = false;

  constructor(env: Env, override?: EngineOverride) {
    ensureLogger();
    this.engine = describeEngine(env, override);
    this.#tts = buildTTS(engineEnv(env, override));
  }

  /**
   * The raw LiveKit TTS, for the ONE caller that needs it: `latency-bench`, which times individual
   * frames off the stream and so cannot go through `say()`. Everything else should use `say()` —
   * it is the path that names the engine in its errors and normalises the sample rate.
   */
  get tts(): ttsBase.TTS {
    return this.#tts;
  }

  /**
   * Synthesizes one Hebrew line.
   *
   * Uses the websocket `stream()` path, NOT `synthesize()`. The REST path returns zero frames for
   * Hebrew on sonic-3 ("AudioByteStream: incomplete frame during flush") — the websocket path is
   * the one the live agent uses and is proven to work.
   *
   * `rate` RE-SAMPLES the result, and it is not optional housekeeping: engines do not agree on an
   * output rate. Cartesia hands back 24kHz and DeepDub hands back 48kHz, and the synthetic caller
   * publishes into a 24kHz `AudioSource`. Feeding it 48k frames does not error — it plays the
   * caller back at the wrong rate, which reads as a broken agent rather than as a broken harness.
   */
  async say(text: string, opts?: { rate?: number }): Promise<AudioFrame[]> {
    const stream = this.#tts.stream();
    stream.pushText(text);
    stream.flush();
    stream.endInput();

    const frames: AudioFrame[] = [];
    for await (const ev of stream) {
      if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
      frames.push(ev.frame);
    }
    stream.close();

    if (frames.length === 0) {
      // AN EMPTY STREAM IS ALMOST NEVER "THIS MODEL CANNOT SPEAK HEBREW". It is a rejected
      // parameter or a missing voice id, reported at DEBUG level and nowhere else. Name the engine
      // in the message so the next reader does not have to guess which one went quiet.
      throw new Error(
        `${this.engine.label} returned NO AUDIO for: ${text.slice(0, 40)} — check the request ` +
          `(a missing or invalid voice id does exactly this), not the model.`,
      );
    }
    return opts?.rate ? reframe(frames, opts.rate) : frames;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#tts.close();
    } catch {
      /* a socket that is already gone is not a failure worth failing a run for */
    }
  }
}

/**
 * Synthesizes one line on the configured engine and closes the connection behind it.
 *
 * For a single clip. Anything that synthesizes several lines should hold a `HarnessVoice` instead
 * — see the connect-cost note on that class.
 */
export async function synthesizeHebrew(
  env: Env,
  text: string,
  override?: EngineOverride,
): Promise<AudioFrame[]> {
  const voice = new HarnessVoice(env, override);
  try {
    return await voice.say(text);
  } finally {
    await voice.close();
  }
}

/** Resamples and re-frames to 10ms frames at `rate`. A copy, never a view into the source. */
export function reframe(frames: AudioFrame[], rate: number): AudioFrame[] {
  const { pcm, rate: srcRate } = concatFrames(frames);
  const out = srcRate === rate ? pcm : resamplePcm(pcm, srcRate, rate);
  const perFrame = Math.max(1, Math.round(rate / 100));
  const framed: AudioFrame[] = [];
  for (let i = 0; i < out.length; i += perFrame) {
    const chunk = out.subarray(i, Math.min(i + perFrame, out.length));
    framed.push(new AudioFrame(Int16Array.from(chunk), rate, 1, chunk.length));
  }
  return framed;
}

// ---------------------------------------------------------------------------------------------
// Reading the engine back off a call the AGENT made
// ---------------------------------------------------------------------------------------------

/**
 * What engine spoke on a recorded call, according to the agent's OWN pipeline observer.
 *
 * This is the only trustworthy source for the agent's half of an A/B clip: the harness knows what
 * IT synthesized, but the reply audio came out of a separate worker process with its own env
 * overlay. Reading it back out of the call report is the same discipline gate 5 of the A/B runner
 * already applies to every other setting.
 *
 * Returns null when there is no call report — in which case the page must say the engine is
 * UNVERIFIED rather than assume it.
 */
export function engineFromPipeline(pipeline: PipelineSnapshot | null): string | null {
  if (!pipeline) return null;
  const read = (key: string): string | null => {
    const v = pipeline.configured[key]?.value;
    return v === undefined || v === null || v === '' ? null : String(v);
  };
  const provider = read('VOICE_TTS_PROVIDER');
  if (!provider) {
    // Older reports predate the key. The SDK label ('deepdub.TTS', 'cartesia.TTS') is weaker but
    // still names the vendor, which beats printing nothing.
    return pipeline.resolved.ttsLabel ?? null;
  }
  const model =
    provider === 'deepdub'
      ? read('DEEPDUB_MODEL')
      : provider === 'elevenlabs'
        ? read('ELEVENLABS_MODEL')
        : read('CARTESIA_MODEL');
  const viaGateway = provider === 'cartesia' && read('VOICE_TTS_ROUTE') === 'inference';
  return (
    `${provider}/${model ?? 'model not in report'}` +
    (viaGateway ? ' (via inference gateway)' : '')
  );
}

/** Filename-safe form of whatever `engineFromPipeline` returned. */
export function engineSlug(label: string | null): string {
  return label ? slugify(label) : 'engine-unverified';
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

/**
 * `--engine=deepdub`, `--model=…`, `--voice=…`, `--route=inference` off a raw argv.
 *
 * A FLAG AND NOT AN ENV VAR, on purpose: `loadEnv()` runs dotenv with `override: true`, so `.env`
 * beats the shell and `VOICE_TTS_PROVIDER=deepdub npm run voice:ab` is a SILENT NO-OP. Every knob
 * this harness offers has to arrive as an argument or through VOICE_TEST_OVERLAY.
 */
export function parseEngineFlags(argv: readonly string[]): EngineOverride | undefined {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const provider = get('engine');
  if (provider !== undefined && !ENGINE_NAMES.includes(provider as EngineName)) {
    throw new Error(`--engine=${provider} is not one of: ${ENGINE_NAMES.join(', ')}`);
  }
  const route = get('route');
  if (route !== undefined && route !== 'cartesia' && route !== 'inference') {
    throw new Error(`--route=${route} is not one of: cartesia, inference`);
  }
  const model = get('model');
  const voice = get('voice');
  const override: EngineOverride = {
    ...(provider !== undefined ? { provider: provider as EngineName } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(route !== undefined ? { route: route as Env['VOICE_TTS_ROUTE'] } : {}),
  };
  return Object.keys(override).length > 0 ? override : undefined;
}

/** The two lines every tool prints before it spends a cent, so the run names its own engine. */
export function engineBanner(engine: EngineDescriptor): string {
  const head =
    `engine: ${engine.label}   voice=${engine.voice ? `${engine.voice.slice(0, 12)}…` : 'NOT SET'}   ` +
    `(VOICE_TTS_PROVIDER=${engine.provider}; pass --engine= to compare another)`;
  const levers = engine.leverNote
    ? `        ⚠ ${engine.leverNote}`
    : `        speed=${engine.speed} volume=${engine.volume} — applied, this engine honours them`;
  return `${head}\n${levers}`;
}
