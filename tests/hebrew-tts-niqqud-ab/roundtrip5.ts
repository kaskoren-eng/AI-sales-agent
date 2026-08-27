/**
 * Round-trip verification for round 5 — the spoken-number word forms and the SPOKEN_REGISTER
 * slang candidates. Same methodology as roundtrip.ts (8kHz phone band → Soniox → intended words
 * heard back), but the accepted fragments live in the MANIFEST (round5.py's `hear` arrays), not
 * a hardcoded map — any one match passes, because Soniox may write a spoken number back as
 * digits ("ארבע וחצי" → "4:30"), which is still proof the pronunciation carried.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip5.ts
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  word: string;
  hear: string[];
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

async function main(): Promise<void> {
  ensureLogger();
  const env = loadEnv();
  const data = JSON.parse(await readFile(join(HERE, 'round5.json'), 'utf-8')) as { cards: Card[] };

  let pass = 0;
  let fail = 0;
  for (const card of data.cards) {
    for (const v of card.variants) {
      const { pcm, sampleRate } = await readWav(join(HERE, v.file));
      const phone = toPhoneRate(pcm, sampleRate);
      const stt = createSonioxSTT(env);
      const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
      const heard = m.text.replace(NIQQUD, '');
      const ok = card.hear.some((t) => heard.includes(t));
      ok ? pass++ : fail++;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${card.id}  sent="${v.text}"  heard="${heard}"` +
          (ok ? '' : `  (expected one of: ${card.hear.join(' | ')})`),
      );
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
