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
/**
 * Liveness is judged by INACTIVITY, not a total cap: a healthy long answer streams chunks
 * continuously, so "no chunk for 10s" means the generation is dead — while a fixed 30s total
 * (v2.0) meant 30 SECONDS OF SILENCE on a real call before anyone noticed. That is exactly the
 * "she disappeared" bug Koren hit on 2026-07-20: one failure was allowed to hold the line.
 */
const GENERATION_IDLE_TIMEOUT_MS = 10_000;
/** Absolute ceiling per sentence, streaming or not — nothing legitimate takes this long. */
const GENERATION_HARD_CAP_MS = 60_000;
/**
 * Two sockets, generations spread across them. Two jobs:
 *  1. FAILURE ISOLATION — a dead socket takes down only ITS generations; v2.0 killed the single
 *     shared socket on any error, which silently hung every other in-flight generation (the SDK's
 *     per-generation promise has no close handling — it just never settles).
 *  2. NO SERVER-SIDE QUEUING — two concurrent generations on ONE socket (a preemptive-TTS draft
 *     plus the real reply) came back as whole-audio-at-once lumps (ttfb == duration, observed
 *     2131ms and 2515ms on Koren's call). Separate sockets, separate lanes.
 */
const SOCKET_POOL_SIZE = 2;

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

interface PoolEntry {
  client: DeepdubClient;
  inFlight: number;
  dead: boolean;
}

export class DeepdubTTS extends tts.TTS {
  label = 'deepdub.TTS';
  #opts: DeepdubTTSOptions;
  #pool: PoolEntry[] = [];
  #dialing = 0;

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

  /** Least-busy open socket from the pool, dialing a fresh one while there is room. */
  async #lease(): Promise<PoolEntry> {
    this.#pool = this.#pool.filter((e) => {
      const alive = !e.dead && e.client.socket?.readyState === 1;
      if (!alive) {
        try {
          e.client.disconnect();
        } catch {
          /* already gone */
        }
      }
      return alive;
    });

    const idle = this.#pool.find((e) => e.inFlight === 0);
    if (idle) return idle;

    if (this.#pool.length + this.#dialing < SOCKET_POOL_SIZE) {
      this.#dialing++;
      try {
        const client = await deepdubCircuit.execute(async () => {
          const fresh = new DeepdubClient(this.#opts.apiKey, {
            protocol: 'websocket',
            eu: this.#opts.eu, // wsapi.eu.deepdub.ai — the EU host is THE latency point, see header
          });
          await fresh.connect();
          return fresh;
        });
        const entry: PoolEntry = { client, inFlight: 0, dead: false };
        this.#pool.push(entry);
        return entry;
      } finally {
        this.#dialing--;
      }
    }

    // Pool is full and busy — share the least-loaded socket (lump risk beats a fresh dial's cost).
    return this.#pool.reduce((a, b) => (a.inFlight <= b.inFlight ? a : b));
  }

  /**
   * Opens the first socket WITHOUT synthesizing anything, so the first real turn doesn't pay the
   * connect. Called at call entry, in parallel with the recording-notice pre-roll (~2s of free
   * time). Best-effort: a failure logs and the first synthesis dials as before.
   */
  async prewarm(): Promise<void> {
    try {
      await this.#lease();
      console.log('deepdub_prewarmed');
    } catch (err) {
      console.error('deepdub_prewarm_failed', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * One sentence → one generation, with ONE retry on a fresh socket.
   *
   * The retry exists for the failure Koren actually hit: a socket dies mid-call, and without a
   * retry the reply is silence and the caller says "הלו? שומעת?" into the void. Retried ONLY when
   * nothing was emitted yet — replaying a half-spoken sentence would stutter, which is worse.
   */
  async generate(text: string, emit: (pcm: Buffer) => void, isCancelled: () => boolean): Promise<void> {
    let emitted = false;
    const guardedEmit = (pcm: Buffer): void => {
      emitted = true;
      emit(pcm);
    };
    try {
      await this.#generateOnce(text, guardedEmit, isCancelled);
    } catch (e) {
      if (isCancelled() || emitted) throw e;
      console.error(
        'deepdub_generation_retry',
        JSON.stringify({ error: asError(e).message, textLen: text.length }),
      );
      await this.#generateOnce(text, guardedEmit, isCancelled);
    }
  }

  /**
   * Chunks stream into `emit` as they arrive (headerless 48k PCM); resolves on the server's
   * explicit isFinished. Fails FAST — not after a long cap — on the two ways a generation
   * actually dies: its socket closing (the SDK promise would otherwise never settle) and chunk
   * inactivity. A failure marks ONLY the leased socket dead; other generations keep their lanes.
   * A cancelled stream stops emitting immediately; the server finishes harmlessly on its own.
   */
  async #generateOnce(
    text: string,
    emit: (pcm: Buffer) => void,
    isCancelled: () => boolean,
  ): Promise<void> {
    const entry = await this.#lease();
    entry.inFlight++;

    const socket = entry.client.socket;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let onSocketClose: (() => void) | undefined;

    const failure = new Promise<never>((_, reject) => {
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => reject(new Error(`DeepDub generation stalled: no chunk for ${GENERATION_IDLE_TIMEOUT_MS}ms`)),
          GENERATION_IDLE_TIMEOUT_MS,
        );
      };
      armIdle();
      (entry as PoolEntry & { armIdle?: () => void }).armIdle = armIdle;
      hardTimer = setTimeout(
        () => reject(new Error(`DeepDub generation exceeded ${GENERATION_HARD_CAP_MS}ms`)),
        GENERATION_HARD_CAP_MS,
      );
      onSocketClose = () => reject(new Error('DeepDub socket closed mid-generation'));
      socket?.once('close', onSocketClose);
    });

    try {
      await Promise.race([
        entry.client.generateToBuffer(text, {
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
            (entry as PoolEntry & { armIdle?: () => void }).armIdle?.();
            if (!isCancelled() && chunk.length > 0) emit(chunk);
          },
        }),
        failure,
      ]);
    } catch (e) {
      // Kill ONLY this socket. v2.0 disconnected the shared client here, which hung every other
      // in-flight generation — the root of the she-went-silent bug.
      entry.dead = true;
      try {
        entry.client.disconnect();
      } catch {
        /* already gone */
      }
      throw e;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (onSocketClose) socket?.off('close', onSocketClose);
      entry.inFlight--;
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
    for (const entry of this.#pool) {
      try {
        entry.client.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.#pool = [];
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
