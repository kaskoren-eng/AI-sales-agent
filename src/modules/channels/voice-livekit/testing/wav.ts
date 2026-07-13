import type { AudioFrame } from '@livekit/rtc-node';

/**
 * Audio helpers for judging voice quality the way the CALLER hears it.
 *
 * A phone call is 8kHz narrowband end to end — the mobile leg is already 8kHz before LiveKit ever
 * sees it, so no codec choice on our side makes it hi-fi. Any voice/speed/volume decision made on
 * 24kHz studio audio is therefore worthless: a voice that is lovely in a browser can be
 * unintelligible on a phone, which is exactly the bug we hit.
 */
const PHONE_RATE = 8_000;

export function concatFrames(frames: AudioFrame[]): { pcm: Int16Array; rate: number } {
  const rate = frames[0]?.sampleRate ?? 0;
  const total = frames.reduce((n, f) => n + f.samplesPerChannel, 0);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const f of frames) {
    pcm.set(f.data, off);
    off += f.samplesPerChannel;
  }
  return { pcm, rate };
}

/**
 * Downsample the way a phone line does: average over each source window, which acts as a crude
 * low-pass. Plain decimation would alias and make every candidate sound equally bad — which would
 * quietly invalidate the comparison you're using this for.
 */
export function toPhoneRate(pcm: Int16Array, srcRate: number): Int16Array {
  const ratio = srcRate / PHONE_RATE;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), pcm.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += pcm[j]!;
    out[i] = Math.round(sum / Math.max(1, end - start));
  }
  return out;
}

/**
 * Resample to an arbitrary rate. Averages when downsampling (crude low-pass, same as toPhoneRate),
 * linearly interpolates when upsampling.
 *
 * Needed because BOTH STT engines want 16kHz, but a phone line is 8kHz. To measure what the STT
 * really faces we round-trip through 8k — `resamplePcm(pcm, 16000, 8000)` then back to 16000 —
 * which destroys the high frequencies exactly as the phone network does while keeping the 16kHz
 * container the APIs expect. Handing the STT clean 16kHz audio would measure a call that never
 * happens.
 */
export function resamplePcm(pcm: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (srcRate === dstRate) return pcm;
  if (dstRate < srcRate) {
    const ratio = srcRate / dstRate;
    const outLen = Math.floor(pcm.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), pcm.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += pcm[j]!;
      out[i] = Math.round(sum / Math.max(1, end - start));
    }
    return out;
  }
  const ratio = dstRate / srcRate;
  const outLen = Math.floor(pcm.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, pcm.length - 1);
    const frac = src - lo;
    out[i] = Math.round(pcm[lo]! * (1 - frac) + pcm[hi]! * frac);
  }
  return out;
}

/**
 * Adds the noise floor a telephone always has and a WAV file never does.
 *
 * THIS IS THE MOST IMPORTANT FUNCTION IN THE HARNESS, because forgetting it is the exact mistake
 * that cost us the most time (docs/phase-4-known-issues.md §5): the synthetic caller fed the agent
 * DIGITAL SILENCE between utterances, measured end-of-turn at 258ms, and a real phone then measured
 * ~950ms with identical config. Silero decides "still speaking" from audio ENERGY, and a phone line
 * is never silent — there is always hiss and comfort noise sitting above the threshold.
 *
 * Any STT/endpointing number measured on clean audio is measured in a world that does not exist on
 * a telephone. `amplitude` is a fraction of full scale; ~0.005 is a quiet but real line.
 */
export function addLineNoise(pcm: Int16Array, amplitude = 0.005, seed = 1): Int16Array {
  const out = new Int16Array(pcm.length);
  const level = amplitude * 32767;
  // Deterministic PRNG (mulberry32) — a corpus that changes between runs cannot be a regression
  // baseline, and Math.random() would silently make every A/B non-reproducible.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < pcm.length; i++) {
    const noise = (rand() * 2 - 1) * level;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]! + noise)));
  }
  return out;
}

/**
 * Finds the speech regions, by energy, over 20ms windows.
 *
 * Exists because CARTESIA'S HEBREW TTS IS NOT DETERMINISTIC. Measured: the same sentence
 * synthesized four times came back 2.9s, 4.1s, 4.5s and 7.1s, and the long takes contain the phrase
 * spoken MORE THAN ONCE, separated by silence. A corpus built from an unvalidated take would hand
 * the STT audio that says a sentence five times while the reference transcript says it once —
 * scoring both engines as catastrophically wrong and poisoning the comparison.
 *
 * So every take is checked before it is written. See `isCleanTake`.
 */
export function speechWindows(pcm: Int16Array, rate: number, threshold = 150): boolean[] {
  const win = Math.max(1, Math.floor(rate * 0.02));
  const out: boolean[] = [];
  for (let i = 0; i + win <= pcm.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += Math.abs(pcm[j]!);
    out.push(sum / win > threshold);
  }
  return out;
}

/**
 * A take is clean if it contains no internal silence long enough to mean the model restarted.
 *
 * These are single short utterances — a person saying "כן" or one sentence. Real speech inside one
 * of them is continuous; a gap of half a second in the MIDDLE means Cartesia stopped and started
 * again, which is the stutter described above. Leading/trailing silence is fine and gets trimmed.
 */
export function isCleanTake(pcm: Int16Array, rate: number, maxGapMs = 500): boolean {
  const windows = speechWindows(pcm, rate);
  const first = windows.indexOf(true);
  const last = windows.lastIndexOf(true);
  if (first === -1) return false; // no speech at all

  const maxGapWindows = Math.ceil(maxGapMs / 20);
  let gap = 0;
  for (let i = first; i <= last; i++) {
    gap = windows[i] ? 0 : gap + 1;
    if (gap > maxGapWindows) return false;
  }
  return true;
}

/** Strips leading and trailing silence, keeping a small pad so the STT hears a clean onset. */
export function trimSilence(pcm: Int16Array, rate: number, padMs = 100): Int16Array {
  const windows = speechWindows(pcm, rate);
  const first = windows.indexOf(true);
  const last = windows.lastIndexOf(true);
  if (first === -1) return pcm;

  const win = Math.max(1, Math.floor(rate * 0.02));
  const pad = Math.floor((padMs / 1000) * rate);
  const start = Math.max(0, first * win - pad);
  const end = Math.min(pcm.length, (last + 1) * win + pad);
  return pcm.slice(start, end);
}

export function encodeWav(pcm: Int16Array, rate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Frames -> an 8kHz WAV: what the caller actually hears. */
export function toPhoneWav(frames: AudioFrame[]): Buffer {
  const { pcm, rate } = concatFrames(frames);
  return encodeWav(toPhoneRate(pcm, rate), PHONE_RATE);
}

/** Frames -> a full-rate WAV: what a browser demo sounds like. Do not judge phone quality on this. */
export function toStudioWav(frames: AudioFrame[]): Buffer {
  const { pcm, rate } = concatFrames(frames);
  return encodeWav(pcm, rate);
}
