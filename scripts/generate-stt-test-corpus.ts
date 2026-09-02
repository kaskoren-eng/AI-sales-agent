/**
 * Generates the Hebrew STT test corpus.
 *
 *   npx tsx --env-file=.env scripts/generate-stt-test-corpus.ts     (or: npm run stt:corpus)
 *
 * Writes, for each of the ten utterances in tests/hebrew-stt-corpus/corpus.ts, THREE WAVs — because
 * a single clean recording would measure a call that never happens:
 *
 *   <id>.clean.wav   16kHz, straight from Cartesia. The best case. Not a phone call.
 *   <id>.phone.wav   16kHz container, but round-tripped through 8kHz — so the high frequencies that
 *                    carry Hebrew consonants are GONE, exactly as the phone network removes them.
 *   <id>.noisy.wav   phone-band PLUS a line-noise floor. The closest thing to reality we can make.
 *
 * The gap between `clean` and `noisy` is the number that matters. If an engine wins on clean audio
 * and collapses on noisy, it loses — our callers are all on phones.
 *
 * WHY THIS IS A .ts AND NOT THE .mjs THE BRIEF ASKED FOR: it imports synthesizeHebrew() and
 * cartesiaOptions() from the agent's own testing module, so the corpus is synthesized with the
 * EXACT Cartesia config the live agent speaks with. A standalone .mjs would have to duplicate that
 * config, and a duplicated config drifts — we have already been burned by an A/B whose two arms
 * turned out to be running identical settings.
 *
 * ---------------------------------------------------------------------------------------------
 * READ THIS BEFORE BELIEVING ANY NUMBER THIS CORPUS PRODUCES.
 *
 * This is SYNTHESIZED speech, not human speech. TTS audio is unnaturally well-articulated: no
 * disfluencies, no mumbling, no accent, no trailing off, no two words running together. Real
 * callers do all of that constantly. So:
 *
 *   - Treat the WER here as a CEILING. Real Hebrew WER will be worse for BOTH engines.
 *   - Treat this as a COMPARATIVE instrument. "Soniox beat OpenAI by 3x on our corpus" is a claim
 *     this can support. "Soniox achieves 1.2% WER on our calls" is NOT.
 *
 * There is no real Hebrew call audio on disk to check against — call recordings live behind remote
 * `recordingUrl`s in the call_learnings table, not in the repo. Shadow mode (SHADOW_STT_ENABLED)
 * exists precisely to close this gap: it runs both engines on REAL callers and logs the
 * disagreement. This corpus tells us whether Soniox is worth pointing at a real call; shadow mode
 * tells us whether it actually won.
 * ---------------------------------------------------------------------------------------------
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import {
  addLineNoise,
  concatFrames,
  encodeWav,
  isCleanTake,
  resamplePcm,
  trimSilence,
} from '../src/modules/channels/voice-livekit/testing/wav.js';
// Moved out of testing/speech.ts on 2026-09-02: the harness now resolves its engine through
// VOICE_TTS_PROVIDER rather than always speaking Cartesia. NOTE FOR THIS SCRIPT: the corpus under
// tests/hebrew-stt-corpus/ was generated on Cartesia, so REGENERATING it on a different engine
// changes the audio every STT WER number in this project was measured against. Regenerate
// deliberately, or not at all.
import { synthesizeHebrew } from '../src/modules/channels/voice-livekit/testing/tts-engine.js';
import { CORPUS, referenceTranscript } from '../tests/hebrew-stt-corpus/corpus.js';
import type { Env } from '../src/config/env.js';

/** Both STT engines take 16kHz. The phone variants are band-limited INSIDE this container. */
const STT_RATE = 16_000;
const PHONE_RATE = 8_000;
const MAX_TAKES = 6;

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'hebrew-stt-corpus');

/**
 * Synthesizes until Cartesia produces a take that isn't stuttered.
 *
 * CARTESIA'S HEBREW TTS IS NOT DETERMINISTIC — this is measured, not defensive coding. The same
 * sentence, four times: 2.9s / 4.1s / 4.5s / 7.1s. The long takes contain the phrase spoken more
 * than once with silence in between. The first version of this script wrote one of them (15.3s for
 * a 3-second sentence) straight into the corpus.
 *
 * Had it stayed, the STT would have been handed audio saying a sentence five times while the
 * reference said it once — both engines would have scored terribly on that file, for reasons having
 * nothing to do with either engine, and the "business" category average would have been garbage.
 *
 * We keep the SHORTEST clean take: with a stutter the model repeats material, so shortest-valid is
 * the one that says the sentence exactly once.
 */
async function bestTake(env: Env, text: string): Promise<{ pcm: Int16Array; takes: number }> {
  const candidates: Int16Array[] = [];

  for (let take = 1; take <= MAX_TAKES; take++) {
    const { pcm, rate } = concatFrames(await synthesizeHebrew(env, text));
    const at16k = trimSilence(resamplePcm(pcm, rate, STT_RATE), STT_RATE);
    if (isCleanTake(at16k, STT_RATE)) {
      candidates.push(at16k);
      // Two clean takes is enough to pick a short one without paying for six every time.
      if (candidates.length >= 2) break;
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Cartesia produced ${MAX_TAKES} stuttered takes for "${text.slice(0, 30)}..." — every one had `
        + 'a >500ms silence gap mid-utterance. Do not fall back to a bad take: it would silently '
        + 'corrupt the A/B. Investigate the TTS first.',
    );
  }

  candidates.sort((a, b) => a.length - b.length);
  return { pcm: candidates[0]!, takes: candidates.length };
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.CARTESIA_API_KEY) throw new Error('CARTESIA_API_KEY is required to synthesize the corpus');

  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Synthesizing ${CORPUS.length} Hebrew utterances x 3 conditions -> ${OUT_DIR}\n`);

  for (const item of CORPUS) {
    // Already 16kHz, trimmed, and validated as un-stuttered.
    const { clean } = await bestTake(env, item.text).then((r) => ({ clean: r.pcm }));
    // Down to 8k and back. The round trip is the point: it PERMANENTLY destroys everything above
    // 4kHz, which is where Hebrew's consonants live. Upsampling cannot restore what is gone —
    // that is precisely what a phone line does to a caller's voice.
    const phone = resamplePcm(resamplePcm(clean, STT_RATE, PHONE_RATE), PHONE_RATE, STT_RATE);
    // Seeded per-utterance so the corpus is byte-identical on every regeneration. A corpus that
    // changes between runs cannot serve as a regression baseline.
    const noisy = addLineNoise(phone, 0.005, hashSeed(item.id));

    await Promise.all([
      writeFile(join(OUT_DIR, `${item.id}.clean.wav`), encodeWav(clean, STT_RATE)),
      writeFile(join(OUT_DIR, `${item.id}.phone.wav`), encodeWav(phone, STT_RATE)),
      writeFile(join(OUT_DIR, `${item.id}.noisy.wav`), encodeWav(noisy, STT_RATE)),
    ]);

    const seconds = (clean.length / STT_RATE).toFixed(1);
    console.log(`  ${item.id.padEnd(12)} ${seconds}s  ${item.text}`);
  }

  await writeFile(
    join(OUT_DIR, 'reference-transcript.json'),
    `${JSON.stringify(referenceTranscript(), null, 2)}\n`,
  );

  console.log(`\nWrote ${CORPUS.length * 3} WAVs + reference-transcript.json`);
  console.log('Ground truth is the exact text handed to Cartesia, so it is true by construction.');
  console.log('\nRemember: this is SYNTHESIZED speech. Use it to compare engines, not to quote an');
  console.log('absolute Hebrew WER. Real callers mumble; Cartesia does not.');
}

/** Stable per-id seed, so each utterance gets a different (but reproducible) noise sequence. */
function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
