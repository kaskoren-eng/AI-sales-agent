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
