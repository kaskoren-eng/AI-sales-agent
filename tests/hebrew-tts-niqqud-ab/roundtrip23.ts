/**
 * Round-trip for round 23 — DeepDub clips -> 8kHz -> Soniox -> did the intended word come back?
 *
 * What it CAN answer here: whether a pointed spelling breaks a word so badly on DeepDub that it
 * comes back as something else (the round-15 `נוח`→`נח` class), and whether the filler spellings
 * come back as words. What it CANNOT answer: homographs — `ליד` spoken "leed" and "le-yad" are
 * the same three letters to a transcriber, and only the ear separates them. Evidence, not a
 * verdict, as every heard-file before it.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip23.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../src/config/env.js';
import { ensureLogger } from '../../src/modules/channels/voice-livekit/testing/speech.js';
import { toPhoneRate } from '../../src/modules/channels/voice-livekit/testing/wav.js';
import { measureStream } from '../../src/modules/channels/voice-livekit/stt/measure.js';
import { createSonioxSTT } from '../../src/modules/channels/voice-livekit/stt/soniox.stt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NIQQUD = /[֑-ׇ]/gu;

interface Card {
  id: string;
  variants: Array<{ key: string; text: string; file: string }>;
}

async function readWav(path: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const buf = await readFile(path);
  const sampleRate = buf.readUInt32LE(24);
  const bytes = buf.subarray(44);
  const pcm = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  return { pcm, sampleRate };
}

function hydrateEnvFromNearestDotenv(): string | null {
  let dir = resolve(HERE, '..', '..');
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf-8').split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
      }
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function main(): Promise<void> {
  ensureLogger();
  const from = hydrateEnvFromNearestDotenv();
  if (from) console.log(`env: ${from}`);
  const env = loadEnv();
  const data = JSON.parse(await readFile(join(HERE, 'round23.json'), 'utf-8')) as { cards: Card[] };

  const heardPath = join(HERE, 'round23-heard.json');
  const heardOut: Record<string, string> = existsSync(heardPath)
    ? (JSON.parse(readFileSync(heardPath, 'utf-8')) as Record<string, string>)
    : {};

  let read = 0;
  for (const card of data.cards) {
    for (const v of card.variants) {
      // The 48kHz studio clip (r23_<id>_<key>.wav), band-limited here — same path as every round.
      const studio = v.file.replace('_phone.wav', '.wav');
      const { pcm, sampleRate } = await readWav(join(HERE, studio));
      const phone = toPhoneRate(pcm, sampleRate);
      const stt = createSonioxSTT(env);
      const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
      const heard = m.text.replace(NIQQUD, '');
      heardOut[`${card.id}_${v.key}`] = heard;
      read++;
      console.log(`READ  ${card.id}_${v.key}  sent="${v.text}"  wrote="${heard || '(nothing)'}"`);
    }
  }
  writeFileSync(heardPath, JSON.stringify(heardOut, null, 2), 'utf-8');
  console.log(`\n${read} clip(s) read. Evidence, not a verdict — re-run build_round23_page.py to fold in.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
