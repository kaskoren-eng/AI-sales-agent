/**
 * Round-trip verification for round 7 — synth → 8kHz phone band → Soniox → what came back?
 *
 * Same machinery as roundtrip6.ts, and a much narrower job, because round 7 is mostly a question
 * about PHRASING and a transcriber has no opinion about which of two well-formed Hebrew sentences
 * sounds less robotic. Exactly two of its claims are machine-checkable:
 *
 *   sg  SCORED. `סגור` is the one word in the slang bank that never went through the round-5
 *       screening — Koren added it himself. The bank's own rule is that an unscreened Hebrew word
 *       fails SILENTLY ("חח" came back as spelled letters; "אוו" vanished), so a word that does not
 *       survive this is a word a lead may hear as noise. PASS means it came back as `סגור`.
 *
 *   n1  UNSCORED, and deliberately: there is no "expected" text. Read what comes back off the A
 *       clips. Round 6 found that both "רק לוודא" and the shipped "רק לוודֵא" return as
 *       "רק לוועדה"; these are the sentences from the 2026-08-31 call, and if the finding
 *       reproduces on this audio then deleting the phrase — rather than respelling it a third
 *       time — is the only move left.
 *
 * A PASS is necessary, never sufficient. Koren's ear on index-round7.html is the other half, and
 * for every OTHER section of that page it is the only half.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip7.ts          # the two sections above
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip7.ts sg       # one section or one card id
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

/** Everything else on the page is a phrasing comparison — running it would cost STT minutes to
 * learn nothing. Name a section or a card id on the command line to override. */
const DEFAULT_SECTIONS = ['sg', 'n1'];

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
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const wanted = args.length > 0 ? args : DEFAULT_SECTIONS;
  const data = JSON.parse(await readFile(join(HERE, 'round7.json'), 'utf-8')) as { cards: Card[] };

  let pass = 0;
  let fail = 0;
  let noted = 0;
  for (const card of data.cards) {
    if (!wanted.includes(card.id) && !wanted.includes(card.section)) continue;
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
