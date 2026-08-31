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
  return trimSilenceWithOffset(pcm, rate, padMs).pcm;
}

/**
 * `trimSilence`, but it also tells you WHERE the kept audio started.
 *
 * Needed because the harness records the agent's track CONTINUOUSLY — a LiveKit agent publishes an
 * audio track for the whole call, silence included — so a captured "reply" begins with however
 * many seconds the caller was talking plus the dead air. Measured on a real run (2026-08-30):
 * 6.34s and 5.98s of leading silence on two 2.5s replies, i.e. the clip on the page was 71%
 * nothing. Trimming alone would be wrong for the whole-call mix, which needs to know how far into
 * the recording the speech actually was; hence the offset.
 */
export function trimSilenceWithOffset(
  pcm: Int16Array,
  rate: number,
  padMs = 100,
): { pcm: Int16Array; startSample: number; hasSpeech: boolean } {
  const windows = speechWindows(pcm, rate);
  const first = windows.indexOf(true);
  const last = windows.lastIndexOf(true);
  // No speech at all: hand the buffer back untouched (that is `trimSilence`'s contract) and say
  // so, because a caller placing this on a timeline must be able to drop it instead.
  if (first === -1) return { pcm, startSample: 0, hasSpeech: false };

  const win = Math.max(1, Math.floor(rate * 0.02));
  const pad = Math.floor((padMs / 1000) * rate);
  const start = Math.max(0, first * win - pad);
  const end = Math.min(pcm.length, (last + 1) * win + pad);
  return { pcm: pcm.slice(start, end), startSample: start, hasSpeech: true };
}

/**
 * Reads a WAV header back off the bytes — the only honest way to know a file is playable.
 *
 * WHY THIS IS HERE AT ALL. 297 clips across every A/B listening round were written with
 * `0xFFFFFFFF` in both the `RIFF` and the `data` size field: the placeholder a writer emits when
 * its output is a pipe and it cannot seek back to patch the real length. Cartesia's `/tts/bytes`
 * response IS such a stream — verified 2026-08-31 by synthesizing one clip and reading the bytes
 * (`52 49 46 46 ff ff ff ff …`) — and the Python round scripts wrote the response straight to disk.
 * Browsers disagree about such a file: some play it, some play noise, some refuse, and none of them
 * report anything. Koren could not play round 7 at all, and an earlier "the voice was not clear"
 * report was chased as a mixing bug while this sat underneath it.
 *
 * `encodeWav` below has always written the sizes correctly, so nothing produced by THIS module was
 * ever broken. The assertion is here anyway, because "we compute it correctly" is what everyone
 * believed about the Python path too, and the check costs a few microseconds on a file we are
 * about to hand to a human. The Python half of the same rule is `tests/hebrew-tts-niqqud-ab/
 * wavcheck.py`.
 */
export function readWavHeader(buf: Buffer): {
  riffSize: number;
  dataSize: number;
  dataOffset: number;
  byteLength: number;
} {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('wav: not a RIFF/WAVE buffer');
  }
  const riffSize = buf.readUInt32LE(4);
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'data') {
      return { riffSize, dataSize: size, dataOffset: i + 8, byteLength: buf.length };
    }
    if (size === 0xffffffff || i + 8 + size > buf.length) break;
    i += 8 + size + (size & 1);
  }
  throw new Error('wav: no `data` chunk found');
}

/** Throws unless the buffer is a WAV a browser will decode. Read back, never assumed. */
export function assertPlayableWav(buf: Buffer): void {
  const h = readWavHeader(buf);
  if (h.riffSize === 0xffffffff || h.dataSize === 0xffffffff) {
    throw new Error('wav: streaming placeholder (0xFFFFFFFF) left in a size field');
  }
  if (h.riffSize !== h.byteLength - 8) {
    throw new Error(`wav: RIFF size ${h.riffSize} != byteLength - 8 (${h.byteLength - 8})`);
  }
  if (h.dataSize !== h.byteLength - h.dataOffset) {
    throw new Error(
      `wav: data size ${h.dataSize} != bytes after the header (${h.byteLength - h.dataOffset})`,
    );
  }
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
  const wav = Buffer.concat([header, data]);
  // The file is not finished until its header has been read back. See readWavHeader above for the
  // round that was lost to a header nobody checked.
  assertPlayableWav(wav);
  return wav;
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
