/**
 * Round-trip verification for round 10 — synth → 8kHz phone band → Soniox → what came back?
 *
 * ── READ THIS BEFORE READING A RESULT ────────────────────────────────────────────────────────
 *
 * A PASS HERE IS NOT A STATEMENT ABOUT PRONUNCIATION, and round 10 is the round where that finally
 * matters. Soniox writes back `אהה` whether Cartesia produced one continuous vowel or Koren's
 * "או-ה" with a glottal break in the middle, because both are the same word. Every earlier round
 * used this harness to check that a word SURVIVES the phone band — `נוח` → `נח`, `רק לוודא` →
 * `רק לוועדה` — and that is all it can ever check. `אהה` reached production with nothing but a
 * transcription-shaped argument behind it, and this is the file that would have said so.
 *
 * So the sections split by what a transcriber can honestly answer:
 *
 *   words       SCORED. `רגע` and `שנייה` are ordinary Hebrew words that have never been through a
 *               phone line in any round. If the band eats one, the fix is not a spelling — it is
 *               removing the word from THINKING_FILLERS_HE. That is a real verdict and this can
 *               give it.
 *
 *   receipts    SCORED, loosely. `אוקיי`, `בסדר`, `הבנתי אותך`, `טוב, הבנתי` are words too. The
 *               expectation is only that the word comes back at all; which of two spellings sounds
 *               better is Koren's, not Soniox's.
 *
 *   receipt     UNSCORED — cards f1, and the interjections in f2/f3, and the nod in n1. There is no
 *   hesitation  "expected" text for a hesitation noise, and inventing one would put a green tick
 *   nod         under a clip only an ear can judge. READ what comes back instead, and read it for
 *               exactly one thing: whether ANYTHING came back. Round 4b is the precedent — `אוו`
 *               transcribed as nothing at all, silently, and written laughter came back as the
 *               NAMES of its letters. A clip whose transcript is empty is a sound the phone band
 *               destroyed, and the page marks those in red.
 *
 * The transcripts are merged into `round10-heard.json` and folded into the page by re-running
 * `round10.py` (which keeps the existing wavs, so this costs nothing but the STT minutes already
 * spent here).
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip10.ts              # every section
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip10.ts words        # one section, or one card id
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

const DEFAULT_SECTIONS = ['receipt', 'hesitation', 'words', 'receipts', 'nod'];

interface Card {
  id: string;
  section: string;
  word: string;
  hear: string[];
  /** WHICH variants `hear` applies to; empty `hear` means the card is unscored by design. */
  score: string[];
  /** The sentence the candidate is spoken in front of, '' for the nod. Written by round10.py. */
  carrier: string;
  variants: Array<{ key: string; text: string; file: string }>;
}

/** Comparison key: no niqqud, no punctuation, no spaces. Only the letters survive. */
const normKey = (s: string): string => s.replace(/[֑-ׇ]/gu, '').replace(/[\s.,:;?!־\-…׳״"']/gu, '');

/**
 * Did the CANDIDATE WORD survive the phone band, as opposed to the sentence after it?
 *
 * THE READING THAT LOOKS FINE AND IS NOT. On the first run of this round `f1_B` (אההה) came back as
 * "כמה פניות נכנסות אליך ביום?" — the carrier transcribed perfectly and the interjection was simply
 * absent. In a list of raw transcripts that is an unremarkable line; it is in fact round 4b's `אוו`
 * failure repeating, where a sound vanished from the transcript with nothing thrown and nobody
 * noticing. Subtracting the carrier is what turns it back into a result.
 */
function candidateSurvived(heard: string, carrier: string): boolean {
  if (!carrier) return normKey(heard) !== '';
  const idx = normKey(heard).indexOf(normKey(carrier));
  // Carrier not found = it came back mangled too; there is nothing to subtract, so make no claim.
  if (idx === -1) return true;
  return idx > 0;
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
  const data = JSON.parse(await readFile(join(HERE, 'round10.json'), 'utf-8')) as { cards: Card[] };

  // Merged rather than overwritten: a partial run must not erase an earlier section's readings.
  const heardPath = join(HERE, 'round10-heard.json');
  const heardOut: Record<string, string> = existsSync(heardPath)
    ? (JSON.parse(readFileSync(heardPath, 'utf-8')) as Record<string, string>)
    : {};

  let pass = 0;
  let fail = 0;
  let noted = 0;
  let vanished = 0;
  for (const card of data.cards) {
    if (!wanted.includes(card.id) && !wanted.includes(card.section)) continue;
    for (const v of card.variants) {
      const { pcm, sampleRate } = await readWav(join(HERE, v.file));
      const phone = toPhoneRate(pcm, sampleRate);
      const stt = createSonioxSTT(env);
      const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
      const heard = m.text.replace(NIQQUD, '');
      heardOut[`${card.id}_${v.key}`] = heard;

      // THE ONE THING THIS HARNESS CAN SAY ABOUT AN INTERJECTION. Everything else on an unscored
      // card is for Koren's ear; a candidate that does not come back AT ALL is a fact, and it is
      // how `אוו` died in round 4b without anyone noticing.
      const survived = candidateSurvived(heard, card.carrier ?? '');
      if (!survived) vanished++;

      if (card.hear.length === 0 || !(card.score ?? []).includes(v.key)) {
        noted++;
        console.log(
          `NOTE  ${card.id}_${v.key}  sent="${v.text}"  heard="${heard}"` +
            (survived ? '' : '   <-- THE WORD ITSELF NEVER CAME BACK'),
        );
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
  if (vanished > 0) {
    console.log(
      `${vanished} candidate(s) never came back at all — the sentence after them transcribed fine ` +
        'and the word itself did not. Those spellings are unusable whatever they sound like.',
    );
  }
  console.log('wrote round10-heard.json — re-run round10.py to fold it into the page (no resynth)');
  // A FAIL is a real word the band ate; the unscored clips are Koren's, and the process must not
  // pretend to have an opinion about them.
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
