import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  AudioByteStream,
  asError,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { DeepdubClient } from '@deepdub/node';
import { CircuitBreaker } from '../../../../shared/circuit-breaker.js';
import type { Env } from '../../../../config/env.js';

/**
 * DeepDub TTS — a hand-written LiveKit `tts.TTS` over DeepDub's PER-GENERATION WebSocket.
 *
 * WHY THIS IS HAND-WRITTEN (unlike the Soniox STT, which uses an official LiveKit plugin): there is
 * no LiveKit plugin for DeepDub. So the parts LiveKit would normally own — framing raw PCM into
 * AudioFrames, the input protocol, TTFB accounting — are implemented here against the base
 * `tts.SynthesizeStream` contract.
 *
 * WHY DEEPDUB AT ALL: it won a blind Hebrew A/B (6:1) on quality and native gender, at cost parity
 * with Cartesia. It is selected only by VOICE_TTS_PROVIDER=deepdub — Cartesia stays shipped.
 * Strangler-fig, one env var to revert, exactly like STT_PROVIDER.
 *
 * WHY THE PER-GENERATION PROTOCOL AND NOT THE STREAMING SESSION (v1 of this file used streaming;
 * switched 2026-07-20 after measuring, at Koren's directive to maximize DeepDub):
 *
 *  1. GEOGRAPHY. The streaming endpoint is GLOBAL-ONLY (`wss.deepdub.ai` — measured 330ms TCP
 *     connect ≈ US), while this protocol has a real EU host (`wsapi.eu.deepdub.ai` — 184ms from
 *     the same machine). ~145ms LESS round-trip baked into EVERY turn, and far less than that
 *     from the eu-central production agent. DeepDub's advertised <200ms floor is only reachable
 *     near their servers.
 *  2. AN EXPLICIT `isFinished` TERMINAL. The streaming session never says "done" — v1 had to
 *     declare end-of-utterance via an idle recv timeout, an artificial tail on every reply. Here
 *     the server says so, exactly.
 *  3. NO SERIALIZATION. Streaming forced ONE generation at a time through a mutex; chunks here
 *     are routed by generationId, so overlapping syntheses (a preemptive-TTS draft plus the real
 *     reply) never queue behind each other.
 *
 * FORMAT: this protocol is WAV-only over WS (no s16le, no sampleRate param) — chunks arrive as
 * 48kHz WAV pieces; `headerless: true` makes the SDK strip each chunk's header, so we frame raw
 * 48k PCM and LiveKit resamples downstream. env DEEPDUB_SAMPLE_RATE is therefore unused here.
 */

const NUM_CHANNELS = 1;
/** The model's native output rate over the per-generation WS protocol (probed: RIFF says 48000). */
const NATIVE_SAMPLE_RATE = 48_000;
/** Hard cap per sentence — the SDK's generation promise has NO timeout of its own; a server that
 * never sends isFinished would otherwise hang the reply forever. */
const GENERATION_TIMEOUT_MS = 30_000;

/**
 * The breaker fits the DISCRETE, awaitable op we own: opening the websocket. Auth failures, a dead
 * region, a network partition — five of those in a row and this stops trying for 30s instead of
 * hammering DeepDub on every turn. Generation errors surface through the base stream error path
 * plus AgentSession's TTS fallback.
 */
export const deepdubCircuit = new CircuitBreaker({
  name: 'deepdub',
  failureThreshold: 5,
  cooldownMs: 30_000,
});

export interface DeepdubTTSOptions {
  apiKey: string;
  voicePromptId: string;
  model: string;
  locale: string;
  sampleRate: number;
  realtime: boolean;
  eu: boolean;
  accentRatio: number;
}

/** Builds DeepDub options from env, failing loudly if the flag is on but the key/voice is missing. */
export function deepdubOptions(env: Env): DeepdubTTSOptions {
  if (!env.DEEPDUB_API_KEY) {
    throw new Error('VOICE_TTS_PROVIDER=deepdub requires DEEPDUB_API_KEY');
  }
  if (!env.DEEPDUB_VOICE_PROMPT_ID) {
    throw new Error('VOICE_TTS_PROVIDER=deepdub requires DEEPDUB_VOICE_PROMPT_ID');
  }
  return {
    apiKey: env.DEEPDUB_API_KEY,
    voicePromptId: env.DEEPDUB_VOICE_PROMPT_ID,
    model: env.DEEPDUB_MODEL,
    locale: env.DEEPDUB_LOCALE,
    sampleRate: env.DEEPDUB_SAMPLE_RATE,
    realtime: env.DEEPDUB_REALTIME,
    eu: env.DEEPDUB_EU,
    accentRatio: env.DEEPDUB_ACCENT_RATIO,
  };
}

function wrapError(e: unknown): APIError {
  if (e instanceof APIError) return e;
  return new APIConnectionError({
    message: `DeepDub TTS failed: ${asError(e).message}`,
    options: { retryable: true },
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DeepdubTTS extends tts.TTS {
  label = 'deepdub.TTS';
  #opts: DeepdubTTSOptions;
  #client: DeepdubClient | null = null;
  #connecting: Promise<DeepdubClient> | null = null;

  constructor(opts: DeepdubTTSOptions) {
    super(NATIVE_SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.#opts = opts;
  }

  override get model(): string {
    return this.#opts.model;
  }

  override get provider(): string {
    return 'deepdub';
  }

  /** Exposed for the stream classes and for tests — never mutate. */
  get options(): DeepdubTTSOptions {
    return this.#opts;
  }

  /** One shared socket; generations multiplex over it by generationId. Reconnects transparently,
   * with a single in-flight connect so concurrent streams don't race to dial. */
  async client(): Promise<DeepdubClient> {
    const c = this.#client;
    if (c?.socket && c.socket.readyState === 1) return c;
    if (!this.#connecting) {
      this.#connecting = deepdubCircuit
        .execute(async () => {
          const fresh = new DeepdubClient(this.#opts.apiKey, {
            protocol: 'websocket',
            eu: this.#opts.eu, // wsapi.eu.deepdub.ai — the EU host is THE latency point, see header
          });
          await fresh.connect();
          return fresh;
        })
        .then((fresh) => {
          this.#client = fresh;
          return fresh;
        })
        .finally(() => {
          this.#connecting = null;
        });
    }
    return this.#connecting;
  }

  /**
   * Opens (or refreshes) the websocket WITHOUT synthesizing anything, so the first real turn
   * doesn't pay the connect. Called at call entry, in parallel with the recording-notice pre-roll
   * (~2s of free time). Best-effort: a failure logs and the first synthesis dials as before.
   */
  async prewarm(): Promise<void> {
    try {
      await this.client();
      console.log('deepdub_prewarmed');
    } catch (err) {
      console.error('deepdub_prewarm_failed', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * One sentence → one generation. Chunks stream into `emit` as they arrive (headerless 48k PCM);
   * resolves on the server's explicit isFinished. A cancelled stream stops emitting immediately —
   * the server finishes on its own, harmlessly, routed to a generationId nobody listens to.
   */
  async generate(text: string, emit: (pcm: Buffer) => void, isCancelled: () => boolean): Promise<void> {
    const client = await this.client();
    try {
      await withTimeout(
        client.generateToBuffer(text, {
          voicePromptId: this.#opts.voicePromptId,
          model: this.#opts.model,
          locale: this.#opts.locale,
          realtime: this.#opts.realtime,
          headerless: true,
          accentControl: {
            accentBaseLocale: this.#opts.locale,
            accentLocale: this.#opts.locale,
            accentRatio: this.#opts.accentRatio,
          },
          onChunk: (chunk: Buffer) => {
            if (!isCancelled() && chunk.length > 0) emit(chunk);
          },
        }),
        GENERATION_TIMEOUT_MS,
        'DeepDub generation',
      );
    } catch (e) {
      // A dead socket poisons every future generation — drop it so the next call redials.
      try {
        this.#client?.disconnect();
      } catch {
        /* already gone */
      }
      this.#client = null;
      throw e;
    }
  }

  override synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new DeepdubChunkedStream(this, text, connOptions, abortSignal);
  }

  override stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new DeepdubSynthesizeStream(this, options?.connOptions);
  }

  override async close(): Promise<void> {
    try {
      this.#client?.disconnect();
    } catch {
      /* already gone */
    }
    this.#client = null;
    await super.close();
  }
}

/** Frames a stream of PCM chunks into AudioFrames, emitting each frame with `final` on the last. */
class FrameEmitter {
  #bstream: AudioByteStream;
  #last: AudioFrame | undefined;
  put: (frame: AudioFrame, final: boolean) => void;

  constructor(sampleRate: number, put: (frame: AudioFrame, final: boolean) => void) {
    this.#bstream = new AudioByteStream(sampleRate, NUM_CHANNELS);
    this.put = put;
  }

  write(chunk: Buffer): void {
    for (const frame of this.#bstream.write(
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    )) {
      this.#flushLast(false);
      this.#last = frame;
    }
  }

  end(): void {
    for (const frame of this.#bstream.flush()) {
      this.#flushLast(false);
      this.#last = frame;
    }
    this.#flushLast(true);
  }

  #flushLast(final: boolean): void {
    if (this.#last) {
      this.put(this.#last, final);
      this.#last = undefined;
    }
  }
}

export class DeepdubSynthesizeStream extends tts.SynthesizeStream {
  label = 'deepdub.SynthesizeStream';
  #dtts: DeepdubTTS;

  constructor(dtts: DeepdubTTS, connOptions?: APIConnectOptions) {
    super(dtts, connOptions);
    this.#dtts = dtts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const cancelled = (): boolean => this.closed || this.abortSignal.aborted;
    try {
      const emitter = new FrameEmitter(NATIVE_SAMPLE_RATE, (frame, final) => {
        if (!this.queue.closed) {
          this.queue.put({ requestId, segmentId: requestId, frame, final });
        }
      });

      // guardStream upstream gates text by SENTENCE, so each input chunk is one speakable
      // sentence → one generation with an exact server-side end. Sequential awaits keep order.
      let started = false;
      for await (const data of this.input) {
        if (cancelled()) break;
        if (data === DeepdubSynthesizeStream.FLUSH_SENTINEL || !data) continue;
        if (!started) {
          // Anchor TTFB to the first sentence actually sent, not to connect/queueing above it.
          this.markStarted();
          started = true;
        }
        await this.#dtts.generate(data, (pcm) => emitter.write(pcm), cancelled);
      }

      emitter.end();
      if (!this.queue.closed) {
        this.queue.put(DeepdubSynthesizeStream.END_OF_STREAM);
      }
    } catch (e) {
      throw wrapError(e);
    }
  }
}

export class DeepdubChunkedStream extends tts.ChunkedStream {
  label = 'deepdub.ChunkedStream';
  #dtts: DeepdubTTS;

  constructor(
    dtts: DeepdubTTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, dtts, connOptions, abortSignal);
    this.#dtts = dtts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    try {
      const emitter = new FrameEmitter(NATIVE_SAMPLE_RATE, (frame, final) => {
        if (!this.queue.closed) {
          this.queue.put({ requestId, segmentId: requestId, frame, final });
        }
      });
      await this.#dtts.generate(
        this.inputText,
        (pcm) => emitter.write(pcm),
        () => this.abortSignal.aborted,
      );
      emitter.end();
    } catch (e) {
      throw wrapError(e);
    }
  }
}
