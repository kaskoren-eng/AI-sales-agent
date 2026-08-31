/**
 * Round-trip reading for round 11 — synth → 8kHz phone band → Soniox → what did it write down?
 *
 * ── THIS HARNESS HAS NO VERDICT TO GIVE ON THIS ROUND, AND SAYING SO IS THE POINT ────────────
 *
 * What the round trip actually measures is whether Soniox can transcribe our own Cartesia output
 * after a phone band. For a CONTENT word that is a real proxy for intelligibility and it has
 * earned its keep — it caught `נוח` → `נח` and `רק לוודא` → `רק לוועדה`, both of which a caller
 * really did mishear. **For a filler or a nod it is close to meaningless.** Nobody needs to
 * transcribe a hesitation; it only has to sound right to a human ear.
 *
 * ROUND 10 PROVED THE LIMIT AND I REPORTED THE RESULT AS THOUGH IT WERE A FINDING. `אמ` was
 * printed as "the word itself never came back" on card `f3`, and the IDENTICAL STRING came back
 * cleanly as `אממ` on card `f1` — same word, same voice, same model, different carrier sentence.
 * Koren then chose it on `f1`, by ear, and he was right. That harness also ended its run by
 * printing "those spellings are unusable whatever they sound like", which was not true and was not
 * mine to say.
 *
 * So this file:
 *   · scores NOTHING and exits 0 whatever it reads;
 *   · never uses the words "fail", "vanished" or "unusable";
 *   · prints the transcript and subtracts the carrier where there is one, because that is
 *     genuinely easier to read, and stops there.
 *
 * A candidate is withdrawn from round 11 by Koren's ear or not at all.
 *
 * The transcripts are merged into `round11-heard.json` and folded into the page by re-running
 * `round11.py` (which keeps the existing wavs, so this costs nothing but the STT seconds spent
 * here).
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip11.ts              # both cards
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip11.ts n1           # one card id, or one section
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

const DEFAULT_SECTIONS = ['nod', 'pair'];

interface Card {
  id: string;
  section: string;
  word: string;
  /** The sentence the candidate is spoken in front of, '' for the nod. Written by round11.py. */
  carrier: string;
  variants: Array<{ key: string; text: string; file: string }>;
}

/** Comparison key: no niqqud, no punctuation, no spaces. Only the letters survive. */
const normKey = (s: string): string => s.replace(/[֑-ׇ]/gu, '').replace(/[\s.,:;?!־\-…׳״"']/gu, '');

/**
 * The transcript with the carrier sentence subtracted — easier to read, and nothing more.
 *
 * Round 10's version of this returned a boolean called `survived` and the page painted an empty
 * result red. See the note at the top: that boolean was not evidence about a hesitation, and it
 * was presented as if it were.
 */
function candidatePart(heard: string, carrier: string): string {
  if (!carrier) return heard.trim();
  const idx = normKey(heard).indexOf(normKey(carrier));
  if (idx <= 0) return heard.trim();
  let seen = 0;
  let cut = 0;
  for (let i = 0; i < heard.length; i++) {
    if (seen >= idx) {
      cut = i;
      break;
    }
    if (!/[\s.,:;?!־\-…׳״"']/u.test(heard[i]!)) seen++;
    cut = i + 1;
  }
  return heard.slice(0, cut).trim();
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
 *
 * A git WORKTREE has no `.env` — it is gitignored, so it lives only in the main checkout, three
 * directories above `.claude/worktrees/<name>/`. `loadEnv()` then injects nothing and dies on
 * DATABASE_URL, and this script is unrunnable from exactly the place voice sessions work from.
 *
 * Order matters and is safe: `loadEnv()` runs dotenv with `override: true`, so a real `.env` in
 * the cwd still WINS over anything set here — this only fills a vacuum. Never copy the file into
 * the worktree instead; `.gitignore` covers `.env*`, but a copied secret is one `git add -f` away
 * from the history. (synth.py walks up for the same reason.)
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
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const wanted = args.length > 0 ? args : DEFAULT_SECTIONS;
  const data = JSON.parse(await readFile(join(HERE, 'round11.json'), 'utf-8')) as { cards: Card[] };

  // Merged rather than overwritten: a partial run must not erase an earlier card's readings.
  const heardPath = join(HERE, 'round11-heard.json');
  const heardOut: Record<string, string> = existsSync(heardPath)
    ? (JSON.parse(readFileSync(heardPath, 'utf-8')) as Record<string, string>)
    : {};

  let read = 0;
  for (const card of data.cards) {
    if (!wanted.includes(card.id) && !wanted.includes(card.section)) continue;
    for (const v of card.variants) {
      const { pcm, sampleRate } = await readWav(join(HERE, v.file));
      const phone = toPhoneRate(pcm, sampleRate);
      const stt = createSonioxSTT(env);
      const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
      const heard = m.text.replace(NIQQUD, '');
      heardOut[`${card.id}_${v.key}`] = heard;
      read++;
      const part = candidatePart(heard, card.carrier ?? '');
      console.log(
        `READ  ${card.id}_${v.key}  sent="${v.text}"  wrote="${heard || '(nothing)'}"` +
          (card.carrier ? `  candidate-part="${part || '(nothing)'}"` : ''),
      );
    }
  }
  writeFileSync(heardPath, JSON.stringify(heardOut, null, 2), 'utf-8');
  console.log(`\n${read} clip(s) read. NONE of this is a verdict.`);
  console.log(
    'A blank line above means Soniox had no word to write for a non-lexical sound — which is what ' +
      'a transcriber does with a nod. It is not evidence that the sound is bad, and round 10 ' +
      'proved it: the same `אמ` printed blank on one card and clean on another, and Koren chose ' +
      'it by ear.',
  );
  console.log('wrote round11-heard.json — re-run round11.py to fold it into the page (no resynth)');
  // Always 0. There is nothing here that a non-zero exit could honestly mean.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
