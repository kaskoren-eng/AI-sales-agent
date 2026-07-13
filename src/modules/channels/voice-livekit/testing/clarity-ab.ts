/**
 * Clarity A/B for the phone line.
 *
 * The caller's complaint is not latency, it's "I can't understand it". A phone call is 8kHz,
 * which strips the high frequencies that carry consonants — so Hebrew turns to mush when spoken
 * fast or quietly. The two levers Cartesia gives us are SPEED and VOLUME.
 *
 * Writes one 8kHz phone-simulated WAV per setting, using the currently configured voice+model.
 * Listen, pick a winner, set VOICE_TTS_SPEED / VOICE_TTS_VOLUME in .env.
 *
 * Usage: npm run voice:clarity
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv } from '../../../../config/env.js';
import { synthesizeHebrew } from './speech.js';
import { toPhoneWav } from './wav.js';

const env = loadEnv();

/** Numbers, an email-ish word, sibilants — the things a caller has to get RIGHT on a booking call. */
const LINE =
  'שלום, קבעתי לך פגישה ביום שלישי בשעה שתיים עשרה וחצי. אשלח אישור למייל שלך. מה כתובת המייל?';

const OUT_DIR = 'voice-samples';

// Cartesia speed: 0.6 (slowest) .. 1.5 (fastest), 1.0 normal. Volume: 0.5 .. 2.0.
const settings = [
  { label: 'current', speed: 1.0, volume: 1.0 },
  { label: 'slower', speed: 0.85, volume: 1.0 },
  { label: 'slower-louder', speed: 0.85, volume: 1.4 },
  { label: 'slowest-louder', speed: 0.7, volume: 1.4 },
];

await mkdir(OUT_DIR, { recursive: true });
console.log(`voice=${env.CARTESIA_VOICE_ID_PRIMARY?.slice(0, 8)}… model=${env.CARTESIA_MODEL}\n`);

for (const s of settings) {
  const frames = await synthesizeHebrew(
    { ...env, VOICE_TTS_SPEED: s.speed, VOICE_TTS_VOLUME: s.volume },
    LINE,
  );
  const path = join(OUT_DIR, `clarity-${s.label}-phone.wav`);
  await writeFile(path, toPhoneWav(frames));
  console.log(`${s.label.padEnd(16)} speed=${s.speed} volume=${s.volume}  -> ${path}`);
}

console.log('\nAll 8kHz phone-simulated. Pick the one you can understand most easily.');
process.exit(0);
