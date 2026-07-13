/**
 * Voice A/B for Hebrew, judged the way the caller actually hears it.
 *
 * Synthesizes the same Hebrew line with each configured Cartesia voice and writes TWO files per
 * voice:
 *   *-studio.wav — the raw 24kHz Cartesia output (what a browser demo sounds like)
 *   *-phone.wav  — the same audio band-limited and resampled to 8kHz (what a PHONE sounds like)
 *
 * Judge on the -phone files. A phone call is 8kHz narrowband end to end — the mobile leg is
 * already 8kHz before LiveKit sees it, so no codec change on our side can make it hi-fi. The only
 * question that matters is which voice stays INTELLIGIBLE once it's crushed to 8kHz, and voices
 * differ wildly on that. Choosing a voice on studio audio is how you end up with a call the
 * customer can't follow.
 *
 * Usage: npm run voice:ab
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioFrame } from '@livekit/rtc-node';
import { loadEnv } from '../../../../config/env.js';
import { synthesizeHebrew } from './speech.js';

const env = loadEnv();

// NOTE: loadEnv() runs dotenv with { override: true }, so .env WINS over the shell environment.
// `CARTESIA_MODEL=sonic-turbo npm run voice:ab` therefore does nothing. Take the model as an
// argument instead: `npm run voice:ab -- sonic-turbo`.
const model = process.argv[2] ?? env.CARTESIA_MODEL;

/** Deliberately contains the sounds Hebrew narrowband mangles: sibilants, gutturals, numbers. */
const LINE =
  'שלום, הגעת ל-ClickScales. אשמח לקבוע לך שיחת היכרות ביום שלישי בשעה שתיים עשרה וחצי. מה שם המשפחה שלך?';

const OUT_DIR = 'voice-samples';
const PHONE_RATE = 8_000;

function concat(frames: AudioFrame[]): { pcm: Int16Array; rate: number } {
  const rate = frames[0]!.sampleRate;
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
 * Downsample to 8kHz the way a phone line does it: average over each source window, which acts as
 * a crude low-pass. Plain decimation would alias and make every voice sound equally bad — which
 * would quietly invalidate the whole comparison.
 */
function toPhone(pcm: Int16Array, srcRate: number): Int16Array {
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

function wav(pcm: Int16Array, rate: number): Buffer {
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

const voices = [
  { label: 'primary', id: env.CARTESIA_VOICE_ID_PRIMARY },
  { label: 'secondary', id: env.CARTESIA_VOICE_ID_SECONDARY },
  { label: 'tertiary', id: env.CARTESIA_VOICE_ID_TERTIARY },
].filter((v): v is { label: string; id: string } => Boolean(v.id));

if (voices.length === 0) {
  console.error('No CARTESIA_VOICE_ID_* set in .env');
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
console.log(`Synthesizing ${voices.length} voice(s) with model ${model}\n`);

for (const v of voices) {
  const t0 = Date.now();
  const frames = await synthesizeHebrew({ ...env, CARTESIA_MODEL: model, CARTESIA_VOICE_ID_PRIMARY: v.id }, LINE);
  const { pcm, rate } = concat(frames);

  const studioPath = join(OUT_DIR, `${v.label}-${model}-studio.wav`);
  const phonePath = join(OUT_DIR, `${v.label}-${model}-phone.wav`);
  await writeFile(studioPath, wav(pcm, rate));
  await writeFile(phonePath, wav(toPhone(pcm, rate), PHONE_RATE));

  console.log(
    `${v.label.padEnd(10)} ${((pcm.length / rate)).toFixed(1)}s audio, synth ${Date.now() - t0}ms`,
  );
  console.log(`  phone (JUDGE THIS): ${phonePath}`);
  console.log(`  studio            : ${studioPath}`);
}

console.log('\nListen to the -phone files. That is what the caller hears.');
process.exit(0);
