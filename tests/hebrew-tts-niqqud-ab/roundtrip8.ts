/**
 * Round-trip verification for round 8 — synth → 8kHz phone band → Soniox → what came back?
 *
 * Round 8 is mostly Koren's ear (is a Hebrew word read-back easier to verify than Latin letters?),
 * and a transcriber has no opinion about that. But this round introduces WORDS the agent has never
 * had to say before, and the standing rule for that is absolute: an unscreened Hebrew word fails
 * SILENTLY. Round 4b is the evidence — written laughter came back as the NAMES of its letters, and
 * "אוו" vanished from the transcript entirely. A method whose vocabulary was never put through a
 * phone line is a method that can fail without anything throwing.
 *
 * So the scored half:
 *
 *   ask, readback  SCORED. `שטרודל` is how an Israeli says "@" and it is now in the agent's mouth
 *                  on every email collection. `ג'ימייל נקודה קום` is the spoken domain, and card
 *                  e2b puts the Hebrew form against the English one on the same line.
 *
 *   letters        UNSCORED, and this is the interesting one. When the word read-back misses she
 *                  falls back to spelling in HEBREW letter names (קיי, איי, אס) instead of English
 *                  ones. NEITHER form has ever been measured on this line. There is no "expected"
 *                  text — read what comes back off both clips and judge which one a transcriber
 *                  could still recover. If the Hebrew names come back as mush, rule 2's fallback
 *                  is wrong and should be changed before it reaches a caller.
 *
 *   giveup         UNSCORED. Rule 5 is permission, not pronunciation; it is here so its one spoken
 *                  line is at least seen through the band once.
 *
 * A PASS is necessary, never sufficient. Koren's ear on index-round8.html is the other half, and
 * for the readback comparison — the whole point of the round — it is the only half.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip8.ts                # scored + letters
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip8.ts letters        # one section or one card id
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

/** e3's two clips are a phrasing comparison and would cost STT minutes to learn nothing. */
const DEFAULT_SECTIONS = ['ask', 'readback', 'letters', 'giveup'];

interface Card {
  id: string;
  section: string;
  word: string;
  hear: string[];
  /** WHICH variants `hear` applies to. The A clip is usually the OLD line, which is not supposed
   * to contain the new word at all — scoring it was a bug in the first run of this file. */
  score: string[];
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
  const data = JSON.parse(await readFile(join(HERE, 'round8.json'), 'utf-8')) as { cards: Card[] };

  // What came back, keyed `<card>_<variant>`, merged into the page by round8.py so Koren judges
  // each clip with the machine's reading of it in front of him rather than in a separate report.
  // Merged rather than overwritten: a partial run must not erase an earlier section's readings.
  const heardPath = join(HERE, 'round8-heard.json');
  const heardOut: Record<string, string> = existsSync(heardPath)
    ? (JSON.parse(readFileSync(heardPath, 'utf-8')) as Record<string, string>)
    : {};

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
      heardOut[`${card.id}_${v.key}`] = heard;
      if (card.hear.length === 0 || !(card.score ?? []).includes(v.key)) {
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
  writeFileSync(heardPath, JSON.stringify(heardOut, null, 2), 'utf-8');
  console.log(`\n${pass} pass, ${fail} fail, ${noted} unscored (no expectation — read them)`);
  console.log('wrote round8-heard.json — re-run round8.py to fold it into the page (no resynth)');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
