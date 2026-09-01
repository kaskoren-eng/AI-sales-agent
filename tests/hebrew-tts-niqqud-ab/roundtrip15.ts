/**
 * Round-trip reading for round 15 — synth → 8kHz phone band → Soniox → what did it write down?
 *
 * ── I EXPECTED THIS ROUND TO BE THE ONE THE HARNESS COULD SETTLE. IT COULD NOT. ───────────────
 *
 * I expected this round to be the one the harness is good for — `נוח` and `ליד` are CONTENT words,
 * and this instrument did once catch `נוח` → `נח` and `רק לוודא` → `רק לוועדה`.
 *
 * IT WAS NOT, AND THE RUN OF 2026-09-01 IS RECORDED HERE SO NOBODY REPEATS THE EXPECTATION:
 * all five `נוח` candidates — plain, two niqqud spellings, holam-only, and the phonetic respelling
 * — came back as the identical string `נוח`. Hebrew is written without vowels, so "no-ach" and
 * "nach" ARE the same three letters: the transcript cannot tell them apart even when a human ear
 * can. The `ליד` cards separated only by spelling (`לייד` came back as `לייד`, English `lead` came
 * back as Hebrew `ליד`), which is a fact about orthography, not about how it sounded.
 *
 * So this round is decided by ear alone. The transcripts are printed because a word that comes
 * back as a DIFFERENT word is still worth seeing — none did — and for nothing else.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip15.ts          # every card
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip15.ts n1 l1    # named cards only
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
  title: string;
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

/**
 * Fill `process.env` from the nearest `.env` at or above the repo root, for keys not already set.
 * A git worktree has no `.env` of its own — see the long note in roundtrip11.ts. `loadEnv()` runs
 * dotenv with `override: true`, so a real `.env` still wins; this only fills a vacuum.
 */
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
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const data = JSON.parse(await readFile(join(HERE, 'round15.json'), 'utf-8')) as { cards: Card[] };

  // Merged rather than overwritten: a partial run must not erase an earlier card's readings.
  const heardPath = join(HERE, 'round15-heard.json');
  const heardOut: Record<string, string> = existsSync(heardPath)
    ? (JSON.parse(readFileSync(heardPath, 'utf-8')) as Record<string, string>)
    : {};

  let read = 0;
  for (const card of data.cards) {
    if (wanted.length > 0 && !wanted.includes(card.id)) continue;
    for (const v of card.variants) {
      // The studio file is read and band-limited HERE rather than reading the _phone.wav the page
      // serves, so the transcriber gets exactly the same code path every earlier round used.
      const { pcm, sampleRate } = await readWav(join(HERE, v.file));
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
  console.log(`\n${read} clip(s) read. This is evidence, not a verdict — his ear decides.`);
  console.log('wrote round15-heard.json — re-run round15.py to fold it into the page (resynths).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
