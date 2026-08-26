/**
 * Round-trip verification for the round-3 pronunciation candidates (the שלכה methodology,
 * speech-guard.ts header): take each candidate clip, squeeze it through an 8kHz phone band,
 * transcribe with Soniox (the production STT), and check the intended STANDARD word is heard.
 *
 * A pass means the trick changed only the VOWELS the caller hears, not the word: Soniox writes
 * standard Hebrew, so hearing back the plain spelling of the target word is the proof the
 * pronunciation is intact. Gender itself is judged by ear on the listening pages — Soniox
 * spells masculine and feminine לך identically, so the transcript cannot check that.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip.ts
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

/** Which standard word each card must come back as. */
const TARGET: Record<string, string> = {
  vd1: 'לוודא', vd2: 'לוודא',
  m1: 'לך', f1: 'לך', m2: 'שלך', f2: 'שלך',
  bm1: 'אותך', bf1: 'אותך',
  bm2: 'אליך', bf2: 'אליך',
  bm3: 'איתך', bf3: 'איתך',
  bm4: 'בשבילך', bf4: 'בשבילך',
  bm5: 'עבורך', bf5: 'עבורך',
};

const NIQQUD = /[֑-ׇ]/gu;

interface Card {
  id: string;
  section: string;
  variants: Array<{ key: string; label: string; text: string; file: string }>;
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
  const cards: Card[] = [];
  for (const manifest of ['round3.json', 'round3b.json']) {
    const data = JSON.parse(await readFile(join(HERE, manifest), 'utf-8'));
    cards.push(...data.cards);
  }

  let pass = 0;
  let fail = 0;
  for (const card of cards) {
    const target = TARGET[card.id];
    if (!target) continue; // ps screening cards have no candidate spelling to verify
    for (const v of card.variants) {
      if (v.key === 'A') continue; // plain control — nothing to verify
      const { pcm, sampleRate } = await readWav(join(HERE, v.file));
      const phone = toPhoneRate(pcm, sampleRate);
      const stt = createSonioxSTT(env);
      const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
      const heard = m.text.replace(NIQQUD, '');
      const ok = heard.includes(target);
      ok ? pass++ : fail++;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${card.id}_${v.key}  sent="${v.text}"  heard="${heard}"` +
          (ok ? '' : `  (expected to contain "${target}")`),
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
