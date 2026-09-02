/**
 * Round-trip for the round-20 breath-tag PROBE — synth -> 8kHz -> Soniox -> was the tag SPOKEN?
 *
 * probe21_tags.py found three variants that got LONGER when a breath tag was added ([sigh] and
 * (breathes) on sonic-3.5, (breathes) on sonic-3.6). A duration table cannot say WHY: a rendered
 * breath and a spoken "breathes" both lengthen the clip — roundtrip17.ts's `br` lesson, verbatim.
 * This file separates them: if Soniox writes back an English word ("sigh", "breathes") or any
 * token the plain variant lacks, the tag is READ ALOUD and dead. If the words come back identical
 * to the baseline, whatever fills the extra time is non-lexical — and only then is it worth an ear.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip21.ts            # A/E/F on both models
 *   npx tsx tests/hebrew-tts-niqqud-ab/roundtrip21.ts m5_E m6_F  # specific clips
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

/** The default reading set: baselines plus every variant the probe flagged as rendered. */
const DEFAULT_KEYS = new Set(['A', 'E', 'F']);

interface ProbeRow {
  model: string;
  key: string;
  label: string;
  text: string;
  file: string | null;
  ms: number | null;
  delta_ms: number | null;
}

async function readWav(path: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const buf = await readFile(path);
  const sampleRate = buf.readUInt32LE(24);
  const bytes = buf.subarray(44);
  const pcm = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  return { pcm, sampleRate };
}

/** Same worktree-safe `.env` walk as roundtrip17.ts — see the long note in roundtrip11.ts. */
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
  const probe = JSON.parse(await readFile(join(HERE, 'probe21.json'), 'utf-8')) as {
    results: ProbeRow[];
  };

  // Merged rather than overwritten, like every earlier round's heard file.
  const heardPath = join(HERE, 'probe21-heard.json');
  const heardOut: Record<string, string> = existsSync(heardPath)
    ? (JSON.parse(readFileSync(heardPath, 'utf-8')) as Record<string, string>)
    : {};

  let read = 0;
  for (const row of probe.results) {
    if (!row.file) continue;
    const clipId = row.file.replace(/^r21_/, '').replace(/\.wav$/, ''); // m5_A …
    const pick = wanted.length > 0 ? wanted.includes(clipId) : DEFAULT_KEYS.has(row.key);
    if (!pick) continue;
    const { pcm, sampleRate } = await readWav(join(HERE, row.file));
    const phone = toPhoneRate(pcm, sampleRate);
    const stt = createSonioxSTT(env);
    const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
    const heard = m.text.replace(NIQQUD, '');
    heardOut[clipId] = heard;
    read++;
    const latin = /[A-Za-z]/.test(heard) ? '  ⚠️ LATIN IN TRANSCRIPT — tag was SPOKEN' : '';
    console.log(`READ  ${clipId} (${row.model} ${row.label})  wrote="${heard || '(nothing)'}"${latin}`);
  }
  writeFileSync(heardPath, JSON.stringify(heardOut, null, 2), 'utf-8');
  console.log(`\n${read} clip(s) read. Identical words to baseline = non-lexical extra time —`);
  console.log('then, and only then, the ear decides what that time actually sounds like.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
