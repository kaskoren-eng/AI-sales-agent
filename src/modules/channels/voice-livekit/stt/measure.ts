import { stt as sttBase } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

/**
 * Drives ANY LiveKit STT engine over a fixed audio buffer and measures it.
 *
 * Engine-agnostic on purpose. Both arms of the A/B run through this exact function, so neither can
 * be accidentally advantaged by how it was fed. We have already been burned by an A/B whose two
 * arms turned out to be running identical config and reported ~180ms of pure noise as an
 * improvement — the structural fix for that class of bug is a harness that CANNOT treat the arms
 * differently.
 *
 *
 * WHY THIS DOES NOT CALL `endInput()`, WHICH IS THE OBVIOUS WAY TO END A BUFFER.
 *
 * It crashes. `VADStream.endInput()` (@livekit/agents/src/vad.ts:261) calls
 * `this.input.writable.close()` while `this.inputWriter` still holds a writer lock on that same
 * writable — Node throws `ERR_INVALID_STATE: WritableStream is locked`. The OpenAI plugin reaches
 * that line the moment its audio input runs dry (`agents-plugin-openai/src/stt.ts:637`).
 *
 * It is a latent bug in the plugin that a live call NEVER hits: on a real call the caller's audio
 * never ends, so the input iterator never completes and that line is never executed. It fires
 * instantly on any finite buffer — i.e. on every test.
 *
 * The workaround is also the more honest experiment. Instead of telling the engine "the audio is
 * over" — something no telephone can say — we append TRAILING SILENCE and let each engine work out
 * for itself that the caller has stopped. That is precisely what happens on a real call, and it is
 * the only way to measure end-of-turn at all: end-of-turn IS the engine's decision about silence.
 *
 * The trailing audio must match the channel: on the `noisy` condition it is line noise, not digital
 * silence. Feeding digital silence is the exact mistake that made the synthetic caller report
 * end-of-turn at 258ms while a real phone measured ~950ms (docs/phase-4-known-issues.md §5) —
 * Silero decides "still speaking" from ENERGY, and a phone line always has some.
 */

/** 20ms at 16kHz — the frame size LiveKit itself streams at. */
const FRAME_MS = 20;

export interface Measurement {
  /** The final transcript, all FINAL_TRANSCRIPT segments joined. */
  text: string;
  /** ms from audio start to the first token of any kind (interim included). Feels like "latency". */
  timeToFirstTokenMs: number | null;
  /** ms from audio start to the last FINAL transcript. */
  timeToFinalMs: number | null;
  /**
   * ms from the moment the SPEECH stopped to the engine committing a final transcript.
   *
   * THE NUMBER THAT DECIDES THE PRODUCT. This is end-of-turn: how long a caller sits in silence
   * after finishing a sentence before the agent can even begin to think. Our live agent pays
   * ~1113ms of it to a Silero silence timer, because no vendor sells a Hebrew end-of-turn model
   * (known-issues §4). If Soniox's server-side endpoint beats that, it is worth more than any
   * accuracy difference.
   */
  endpointDelayMs: number | null;
  /** Seconds of audio the engine reported billing us for, if it reports it at all. */
  audioDurationSec: number;
  /** Interim transcripts, in order — how the engine changed its mind as it listened. */
  interims: string[];
  /** True when we gave up waiting for a final transcript. */
  timedOut: boolean;
  error?: string;
}

export interface MeasureOptions {
  /**
   * Audio to append after the speech, simulating the line while the caller is quiet.
   *
   * MUST match the channel being tested. Digital silence (all zeros) is only right for the `clean`
   * condition; a phone line is never silent. If omitted, digital silence is used — which will
   * flatter every engine's end-of-turn and reproduce our most expensive past mistake.
   */
  trailingAudio?: Int16Array;
  /** How long to wait for a final transcript after the speech ends. */
  maxTrailingMs?: number;
  /**
   * Feed the audio at 1x wall-clock speed, as a phone call does. ON BY DEFAULT, AND IT MATTERS:
   * dumping the buffer at once measures burst throughput, a question nobody is asking, and would
   * flatter whichever engine has the fatter pipe.
   */
  realtime?: boolean;
}

export async function measureStream(
  stt: sttBase.STT,
  pcm: Int16Array,
  sampleRate: number,
  opts: MeasureOptions = {},
): Promise<Measurement> {
  const realtime = opts.realtime ?? true;
  const maxTrailingMs = opts.maxTrailingMs ?? 4_000;
  const samplesPerFrame = Math.floor((sampleRate * FRAME_MS) / 1000);
  const trailing =
    opts.trailingAudio ?? new Int16Array(Math.ceil((maxTrailingMs / 1000) * sampleRate));

  const stream = stt.stream();
  const interims: string[] = [];
  const finals: string[] = [];
  let firstTokenAt: number | null = null;
  let finalAt: number | null = null;
  let audioDurationSec = 0;
  let error: string | undefined;
  let gotFinal = false;

  const startedAt = Date.now();
  let speechEndedAt: number | null = null;

  // Push audio in the background while the loop below drains events. Pushing everything first and
  // only then reading would deadlock a long file against the stream's backpressure.
  const pump = (async () => {
    for (let off = 0; off < pcm.length; off += samplesPerFrame) {
      stream.pushFrame(frameAt(pcm, off, samplesPerFrame, sampleRate));
      if (realtime) await sleep(FRAME_MS);
    }
    // The caller has stopped talking. Everything after this point is the engine deciding that.
    speechEndedAt = Date.now();

    // Keep the line open with condition-matched silence until the engine commits, or we give up.
    const deadline = Date.now() + maxTrailingMs;
    for (let off = 0; off < trailing.length && !gotFinal && Date.now() < deadline; off += samplesPerFrame) {
      stream.pushFrame(frameAt(trailing, off, samplesPerFrame, sampleRate));
      if (realtime) await sleep(FRAME_MS);
    }
  })();

  const consume = (async () => {
    for await (const ev of stream) {
      switch (ev.type) {
        case sttBase.SpeechEventType.INTERIM_TRANSCRIPT:
        case sttBase.SpeechEventType.PREFLIGHT_TRANSCRIPT: {
          firstTokenAt ??= Date.now();
          const text = ev.alternatives?.[0]?.text ?? '';
          if (text) interims.push(text);
          break;
        }
        case sttBase.SpeechEventType.FINAL_TRANSCRIPT: {
          firstTokenAt ??= Date.now();
          finalAt = Date.now();
          const text = ev.alternatives?.[0]?.text ?? '';
          if (text) finals.push(text);
          // Only stop once the speech is actually over. An engine may commit mid-utterance at a
          // natural pause; that is a partial, not the end of the turn.
          if (speechEndedAt !== null) {
            gotFinal = true;
            return;
          }
          break;
        }
        case sttBase.SpeechEventType.RECOGNITION_USAGE: {
          audioDurationSec += ev.recognitionUsage?.audioDuration ?? 0;
          break;
        }
        default:
          break;
      }
    }
  })();

  try {
    await Promise.race([consume, pump.then(() => waitFor(() => gotFinal, maxTrailingMs))]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // The stream is deliberately abandoned rather than endInput()'d — see the header. close() tears
  // down the socket without touching the VAD's locked writable.
  try {
    stream.close();
  } catch {
    // Already closed by the engine; nothing to do.
  }
  await pump.catch(() => {});

  return {
    text: finals.join(' ').replace(/\s+/gu, ' ').trim(),
    timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
    timeToFinalMs: finalAt === null ? null : finalAt - startedAt,
    endpointDelayMs:
      finalAt === null || speechEndedAt === null ? null : Math.max(0, finalAt - speechEndedAt),
    audioDurationSec: audioDurationSec || pcm.length / sampleRate,
    interims,
    timedOut: !gotFinal,
    error,
  };
}

/**
 * Builds one 20ms frame — with its OWN backing buffer. The copy is not defensive style; it is
 * load-bearing, and omitting it silently destroys the experiment.
 *
 * `pcm.subarray()` returns a VIEW: a short Int16Array whose `.buffer` is the ENTIRE source file,
 * with a non-zero `byteOffset`. The OpenAI plugin then does
 * `audioStream.write(item.data.buffer as ArrayBuffer)` — reading `.buffer` WITHOUT honoring
 * byteOffset/byteLength (agents-plugin-openai/src/stt.ts:633). So it transmits the whole audio file
 * on every single frame instead of that 20ms slice.
 *
 * The failure is invisible and total: OpenAI receives nonsense, never detects speech, never
 * commits, and returns NOTHING. Not a bad transcript — an empty one, with no error and no log.
 * Scored naively, that is 100% WER on every file, and Soniox wins the A/B by a landslide that is
 * purely this bug. `new Int16Array(view)` copies into a tight buffer, so `.buffer` is exactly the
 * frame.
 *
 * The Soniox plugin gets this right (it honors byteOffset explicitly, and its source says so).
 * The OpenAI one does not. Any future harness that hands LiveKit STT plugins sliced audio must copy.
 */
function frameAt(pcm: Int16Array, offset: number, size: number, sampleRate: number): AudioFrame {
  const view = pcm.subarray(offset, Math.min(offset + size, pcm.length));
  const owned = new Int16Array(view); // copy — see above
  return new AudioFrame(owned, sampleRate, 1, owned.length);
}

/** Polls a predicate until true or the timeout elapses. Used to bound the wait for a final. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(20);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
