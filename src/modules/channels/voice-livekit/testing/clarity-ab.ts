/**
 * Clarity A/B for the phone line.
 *
 * The caller's complaint is not latency, it's "I can't understand it". A phone call is 8kHz,
 * which strips the high frequencies that carry consonants — so Hebrew turns to mush when spoken
 * fast or quietly. The two levers we have are SPEED and VOLUME.
 *
 * AND THEY ARE CARTESIA'S LEVERS, NOT THE INDUSTRY'S. `VOICE_TTS_SPEED` and `VOICE_TTS_VOLUME`
 * reach Cartesia (both routes) and nothing else: the DeepDub adapter sends neither, and the
 * ElevenLabs path does not carry them. On a non-Cartesia engine this script would therefore render
 * four IDENTICAL clips and present them as a comparison — which is precisely the failure the A/B
 * runner has a whole gate against ("two identical clips labelled A and B"). So it refuses, says
 * why, and renders ONE labelled reference clip instead. `--anyway` renders all four so you can
 * hear for yourself that they are the same.
 *
 * Writes one 8kHz phone-simulated WAV per setting, using the configured engine, voice and model.
 * Listen, pick a winner, set VOICE_TTS_SPEED / VOICE_TTS_VOLUME in .env.
 *
 * Usage:
 *   npm run voice:clarity
 *   npm run voice:clarity -- --engine=cartesia     compare the levers on the engine that has them
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv } from '../../../../config/env.js';
import { HarnessVoice, describeEngine, engineBanner, parseEngineFlags } from './tts-engine.js';
import { toPhoneWav } from './wav.js';

const env = loadEnv();
const argv = process.argv.slice(2);
const override = parseEngineFlags(argv);
const anyway = argv.includes('--anyway');

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

const engine = describeEngine(env, override);
await mkdir(OUT_DIR, { recursive: true });
console.log(engineBanner(engine));
console.log('');

const honoured = engine.honoursSpeedVolume;
if (!honoured && !anyway) {
  console.log(
    `SPEED AND VOLUME DO NOTHING ON ${engine.provider.toUpperCase()}.\n\n` +
      `  ${engine.leverNote}\n\n` +
      `  Rendering ONE reference clip instead of four identical ones. Four clips that differ only\n` +
      `  in a parameter the engine never received is not a comparison, it is a trap — and this\n` +
      `  project has already lost a round to two arms that turned out to be the same config.\n\n` +
      `  --anyway                render all four so you can hear that they are identical\n` +
      `  --engine=cartesia       run the levers on the engine that actually has them\n`,
  );
}

const toRender = honoured || anyway ? settings : [settings[0]!];
const voices = new Map<string, HarnessVoice>();

try {
  for (const s of toRender) {
    // A fresh engine per setting ONLY where the setting reaches the engine — speed/volume are
    // constructor options on the Cartesia plugin, so they cannot be changed on an open instance.
    // Where they are ignored, one engine serves every row.
    const cacheKey = honoured ? `${s.speed}/${s.volume}` : 'single';
    let voice = voices.get(cacheKey);
    if (!voice) {
      voice = new HarnessVoice(env, {
        ...override,
        env: honoured ? { VOICE_TTS_SPEED: s.speed, VOICE_TTS_VOLUME: s.volume } : {},
      });
      voices.set(cacheKey, voice);
    }

    const frames = await voice.say(LINE);
    // The engine is in the filename, and so is whether the levers were applied — a clip named
    // `clarity-slower-…` that was rendered at the engine's own rate is a lie waiting to happen.
    const applied = honoured ? `speed${s.speed}-vol${s.volume}` : 'engine-default-rate';
    const path = join(OUT_DIR, `clarity-${s.label}-${engine.slug}-${applied}-phone.wav`);
    await writeFile(path, toPhoneWav(frames));
    console.log(
      `${s.label.padEnd(16)} ${honoured ? `speed=${s.speed} volume=${s.volume}` : 'levers IGNORED by this engine'}  -> ${path}`,
    );
  }
} finally {
  for (const v of voices.values()) await v.close();
}

console.log('\nAll 8kHz phone-simulated. Pick the one you can understand most easily.');
if (!honoured) {
  console.log(
    `⚠ ${engine.provider} ignored VOICE_TTS_SPEED / VOICE_TTS_VOLUME. Nothing above is evidence\n` +
      `  about those two knobs — only about how this engine sounds at its own rate.`,
  );
}
process.exit(0);
