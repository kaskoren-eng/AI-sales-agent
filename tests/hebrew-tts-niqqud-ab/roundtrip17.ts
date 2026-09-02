/**
 * Round-trip verification for round 17 — synth -> 8kHz phone band -> Soniox -> what came back?
 *
 * ONE CARD IS WHAT THIS IS FOR. `br` asks whether Cartesia HONOURS `<break time="..."/>` on Hebrew
 * or READS IT ALOUD, and that is the one question a pause measurement cannot answer: a spoken tag
 * and a real pause both lengthen the clip. If `br_D` or `br_E` come back with English, with a
 * stray word, or with anything the punctuation variants do not have, the tag is being spoken and
 * the largest untested pacing lever in the stack is dead. If they come back identical to `br_A`,
 * it is alive — and Koren's ear then decides whether the silence sounds like a beat or a dropout.
 *
 * WHAT IT CANNOT JUDGE, and do not read a green run as if it could:
 *   - `sp` and `tr` are the SAME TEXT at different speeds. They must round-trip identically; that
 *     proves only that slowing her down does not corrupt the words. Nothing about how it sounds.
 *   - `em` differs only in punctuation, which Soniox does not write back reliably. No expectation.
 *   - `df` is disfluency. A transcriber may legitimately drop a non-lexical sound — but one that
 *     comes back as a WORD is exactly the failure this round exists to catch, so the heard text is
 *     printed and judged by eye.
 *
 * A PASS is necessary, never sufficient. index-round17.html is the other half.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip17.ts
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip17.ts br      # one card
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
  const data = JSON.parse(await readFile(join(HERE, 'round17.json'), 'utf-8')) as { cards: Card[] };

  // Merged rather than overwritten: a partial run must not erase an earlier card's readings.
  const heardPath = join(HERE, 'round17-heard.json');
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
  console.log('wrote round17-heard.json — re-run build_round17_page.py to fold it into the page.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
