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
 * DeepDub TTS — a hand-written LiveKit `tts.TTS` over DeepDub's streaming WebSocket.
 *
 * WHY THIS IS HAND-WRITTEN (unlike the Soniox STT, which uses an official LiveKit plugin): there is
 * no LiveKit plugin for DeepDub. So the parts LiveKit would normally own — framing raw PCM into
 * AudioFrames, the input/flush protocol, TTFB accounting — are implemented here against the base
 * `tts.SynthesizeStream` contract, mirroring how `@livekit/agents-plugin-cartesia` does it.
 *
 * WHY DEEPDUB AT ALL: it won a blind Hebrew A/B (6:1) on quality and native gender, at cost parity
 * with Cartesia, and its realtime model reports ~125ms TTFB. It is NOT the default — Cartesia stays
 * shipped — this is selected only by VOICE_TTS_PROVIDER=deepdub. Strangler-fig, one env var to
 * revert, exactly like STT_PROVIDER. See tests/hebrew-tts-niqqud-ab/ for the evidence.
 *
 * KEY DESIGN — ONE PERSISTENT CONNECTION, REUSED. A fresh streaming connect costs ~550ms; the
 * realtime win only exists on a WARM socket. Verified that DeepDub keeps the streaming socket open
 * across generations (gen2 on the same socket: 331ms TTFB, socket still OPEN), so this holds a single
 * connection on the TTS instance and serializes turns through it. A dead socket is transparently
 * reconnected; the connect (the real failure point: auth, network) is what the circuit breaker wraps.
 *
 * RAW PCM, NOT WAV. We ask DeepDub for `s16le` (not `wav`), so each chunk is headerless PCM that
 * feeds `AudioByteStream` directly — no per-chunk RIFF header to strip.
 */

const NUM_CHANNELS = 1;
// How DeepDub signals "generation done": it DOESN'T. The streaming protocol never sends an
// `isFinished: true` terminal — the official SDK example drains until a recv timeout, and so do we.
// FIRST_AUDIO waits out the model's cold/first-token latency; once audio is flowing, a gap longer
// than IDLE means the utterance is over (chunks otherwise arrive faster than realtime). IDLE is a
// truncation-vs-latency trade: too short clips the tail on a network hiccup, too long holds the
// shared connection past the turn. 800ms is comfortably above observed inter-chunk gaps.
const FIRST_AUDIO_TIMEOUT_MS = 12_000;
const RECV_IDLE_TIMEOUT_MS = 800;

/**
 * The breaker fits the DISCRETE, awaitable op we own: opening the streaming connection. Auth
 * failures, a dead region, a network partition — five of those in a row and this stops trying for
 * 30s instead of hammering DeepDub on every turn. The long-lived streaming read itself is guarded by
 * the base `SynthesizeStream.run()` error path plus AgentSession's TTS fallback, the same division of
 * labour documented for the Soniox breaker (stt/soniox.stt.ts).
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

const isOpen = (c: DeepdubClient): boolean => !!c.streamingSocket && c.streamingSocket.readyState === 1;

function safeDisconnect(c: DeepdubClient): void {
  try {
    c.disconnectStreaming();
  } catch {
    /* already gone */
  }
}

async function connectStreaming(opts: DeepdubTTSOptions): Promise<DeepdubClient> {
  const client = new DeepdubClient(opts.apiKey, { protocol: 'websocket', eu: opts.eu });
  await client.asyncStreamConnect({
    model: opts.model,
    locale: opts.locale,
    voicePromptId: opts.voicePromptId,
    // Headerless PCM straight into AudioByteStream.
    format: 's16le',
    sampleRate: opts.sampleRate,
    realtime: opts.realtime,
  });
  return client;
}

/**
 * Drains one DeepDub generation into the frame emitter and returns the moment it is DONE.
 *
 * DeepDub streaming sends no terminal message, so end-of-utterance is a recv timeout: a long window
 * for the first chunk (cold/first-token latency), then a short idle gap once audio is flowing. We
 * still break on `isFinished` in case a future model does send it. `asyncStreamRecv` (not
 * `...RecvAudio`) is used so we see the raw message and can react to errors and flags.
 */
async function receiveAudio(
  client: DeepdubClient,
  emitter: FrameEmitter,
  isCancelled: () => boolean,
): Promise<void> {
  let gotAudio = false;
  while (!isCancelled()) {
    const timeoutMs = gotAudio ? RECV_IDLE_TIMEOUT_MS : FIRST_AUDIO_TIMEOUT_MS;
    const msg = await client.asyncStreamRecv({ timeoutMs });
    if (msg === null) break; // idle gap after audio => done; or first-audio timeout => give up
    if (msg.error) throw new Error(String(msg.message ?? msg.error));
    if (typeof msg.data === 'string' && msg.data.length > 0) {
      emitter.write(Buffer.from(msg.data, 'base64'));
      gotAudio = true;
    }
    if (msg.isFinished) break;
  }
  emitter.end();
}

function wrapError(e: unknown): APIError {
  if (e instanceof APIError) return e;
  return new APIConnectionError({
    message: `DeepDub TTS failed: ${asError(e).message}`,
    options: { retryable: true },
  });
}

export class DeepdubTTS extends tts.TTS {
  label = 'deepdub.TTS';
  #opts: DeepdubTTSOptions;
  #idle: DeepdubClient | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(opts: DeepdubTTSOptions) {
    super(opts.sampleRate, NUM_CHANNELS, { streaming: true });
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

  /**
   * Serializes generations through ONE reused streaming connection. Each caller awaits the previous
   * caller's `release()`, gets a warm (or freshly reconnected) socket, and must call `release`.
   */
  async acquire(): Promise<{ client: DeepdubClient; release: (healthy: boolean) => void }> {
    let unlock!: () => void;
    const gate = new Promise<void>((r) => {
      unlock = r;
    });
    const prev = this.#chain;
    this.#chain = prev.then(() => gate);
    await prev;

    let client = this.#idle;
    this.#idle = null;
    if (!client || !isOpen(client)) {
      if (client) safeDisconnect(client);
      client = await deepdubCircuit.execute(() => connectStreaming(this.#opts));
    }
    const release = (healthy: boolean): void => {
      if (healthy && isOpen(client)) this.#idle = client;
      else safeDisconnect(client);
      unlock();
    };
    return { client, release };
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
    if (this.#idle) safeDisconnect(this.#idle);
    this.#idle = null;
    await super.close();
  }
}

/** Frames a stream of PCM chunks into AudioFrames, emitting each frame with `final` on the last. */
class FrameEmitter {
  #bstream: AudioByteStream;
  #last: AudioFrame | undefined;
  constructor(
    sampleRate: number,
    private readonly put: (frame: AudioFrame, final: boolean) => void,
  ) {
    this.#bstream = new AudioByteStream(sampleRate, NUM_CHANNELS);
  }
  write(chunk: Buffer): void {
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    for (const frame of this.#bstream.write(ab)) {
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
  #opts: DeepdubTTSOptions;

  constructor(dtts: DeepdubTTS, connOptions?: APIConnectOptions) {
    super(dtts, connOptions);
    this.#dtts = dtts;
    this.#opts = dtts.options;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const { client, release } = await this.#dtts.acquire();
    let healthy = true;
    try {
      const emitter = new FrameEmitter(this.#opts.sampleRate, (frame, final) => {
        if (!this.queue.closed) {
          this.queue.put({ requestId, segmentId: requestId, frame, final });
        }
      });

      const inputTask = (async () => {
        let started = false;
        for await (const data of this.input) {
          if (data === DeepdubSynthesizeStream.FLUSH_SENTINEL) continue; // DeepDub streams continuously
          if (!data) continue;
          if (!started) {
            // Anchor TTFB to the first byte actually sent, not to connect/queueing above it.
            this.markStarted();
            started = true;
          }
          await client.asyncStreamText(data);
        }
        await client.asyncStreamEnd();
      })();

      const recvTask = receiveAudio(client, emitter, () => this.closed || this.abortSignal.aborted);

      await Promise.all([inputTask, recvTask]);
      if (!this.queue.closed) {
        this.queue.put(DeepdubSynthesizeStream.END_OF_STREAM);
      }
    } catch (e) {
      healthy = false;
      throw wrapError(e);
    } finally {
      release(healthy);
    }
  }
}

export class DeepdubChunkedStream extends tts.ChunkedStream {
  label = 'deepdub.ChunkedStream';
  #dtts: DeepdubTTS;
  #opts: DeepdubTTSOptions;

  constructor(
    dtts: DeepdubTTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, dtts, connOptions, abortSignal);
    this.#dtts = dtts;
    this.#opts = dtts.options;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const { client, release } = await this.#dtts.acquire();
    let healthy = true;
    try {
      const emitter = new FrameEmitter(this.#opts.sampleRate, (frame, final) => {
        if (!this.queue.closed) {
          this.queue.put({ requestId, segmentId: requestId, frame, final });
        }
      });
      await client.asyncStreamText(this.inputText);
      await client.asyncStreamEnd();
      await receiveAudio(client, emitter, () => this.abortSignal.aborted);
    } catch (e) {
      healthy = false;
      throw wrapError(e);
    } finally {
      release(healthy);
    }
  }
}
