/**
 * Round-trip verification for round 6 — synth → 8kHz phone band → Soniox → did the intended word
 * come back? Same methodology as roundtrip.ts / roundtrip5.ts, and the same standing rule: a PASS
 * is necessary, never sufficient. Koren's ear on index-round6.html is the other half.
 *
 * WHAT THIS CAN AND CANNOT JUDGE — read before trusting a green run:
 *
 *   - It CAN judge נוח and לוודא: those are single-reading words, so a mark that mangles the word
 *     shows up as different text coming back.
 *   - It CANNOT judge רוצה (the `g` and `sw` sections). Masculine and feminine are the SAME
 *     LETTERS, and Soniox writes back unpointed Hebrew — so both genders round-trip as "רוצה" and
 *     a PASS proves only that the vowel mark did not corrupt the word. Those cards are scored here
 *     for corruption only; the gender itself is decided by the forced choice on the page.
 *   - It CANNOT judge the fillers (`fl`, `nd`): a non-lexical vocalisation is not a word Soniox
 *     owes us anything for, and it may legitimately drop it. Those cards carry no expectation and
 *     are skipped; the heard text is still printed, because a filler that comes back as a WORD
 *     ("אוהה") is exactly the defect Koren reported.
 *   - For `ps1_E` it answers the one question the pause probe cannot: the tag produced a 650ms
 *     silence, but is it a PAUSE or is Cartesia reading the tag out loud? If the heard text
 *     carries English or a stray word around "שלום", the tag is being spoken and the idea is dead.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip6.ts
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
  section: string;
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
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const data = JSON.parse(await readFile(join(HERE, 'round6.json'), 'utf-8')) as { cards: Card[] };

  let pass = 0;
  let fail = 0;
  let noted = 0;
  for (const card of data.cards) {
    if (only.length > 0 && !only.includes(card.id) && !only.includes(card.section)) continue;
    for (const v of card.variants) {
      const { pcm, sampleRate } = await readWav(join(HERE, v.file));
      const phone = toPhoneRate(pcm, sampleRate);
      const stt = createSonioxSTT(env);
      const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
      const heard = m.text.replace(NIQQUD, '');
      if (card.hear.length === 0) {
        noted++;
        console.log(`NOTE  ${card.id}_${v.key}  sent="${v.text}"  heard="${heard}"`);
        continue;
      }
      const ok = card.hear.some((t) => heard.includes(t));
      ok ? pass++ : fail++;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${card.id}_${v.key}  sent="${v.text}"  heard="${heard}"` +
          (ok ? '' : `  (expected one of: ${card.hear.join(' | ')})`),
      );
    }
  }
  console.log(`\n${pass} pass, ${fail} fail, ${noted} unscored (no expectation — read them)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
