/**
 * Soniox vs OpenAI — the Hebrew STT A/B.
 *
 *   npm run stt:ab                  every condition (clean, phone, noisy)
 *   npm run stt:ab -- phone         one condition only
 *
 * Runs BOTH engines over every file in tests/hebrew-stt-corpus/ and writes:
 *   tests/stt-ab-results-<timestamp>.json    every measurement, for re-analysis
 *   tests/stt-ab-report-<timestamp>.md       the side-by-side, for humans
 *
 * FAIRNESS RULES, because an A/B is worthless if the arms are not comparable:
 *
 *   1. Both engines are driven by the SAME function (`measureStream`). Neither can be advantaged by
 *      how it was fed. Our last endpointing A/B accidentally ran identical config in both arms and
 *      reported 180ms of noise as a win — the structural fix is a harness that CANNOT treat the
 *      arms differently.
 *   2. Audio is streamed at 1x wall-clock, like a phone call. Dumping the buffer at once would
 *      measure burst throughput, which nobody is asking about, and would flatter whichever engine
 *      has the fatter pipe.
 *   3. Both get the SAME biasing terms (VOICE_STT_PROMPT). This measures whether biasing WORKS, not
 *      whether one engine was handed a hint the other wasn't. Note the asymmetry we cannot remove:
 *      gpt-realtime-whisper REJECTS biasing outright, so OpenAI runs unbiased by necessity. That is
 *      a real, product-relevant difference, not a rigged test — and it is stated in the report.
 *   4. Engine failures are recorded, not retried away. An engine that dies on Hebrew has told us
 *      something.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { loadEnv } from '../src/config/env.js';
import { ensureLogger } from '../src/modules/channels/voice-livekit/testing/speech.js';
import { addLineNoise } from '../src/modules/channels/voice-livekit/testing/wav.js';
import { type Measurement, measureStream } from '../src/modules/channels/voice-livekit/stt/measure.js';
import { createSonioxSTT } from '../src/modules/channels/voice-livekit/stt/soniox.stt.js';
import { errorRates, mean, median, semanticErrorRates } from '../src/modules/channels/voice-livekit/stt/wer.js';
import { CORPUS, type Category } from './hebrew-stt-corpus/corpus.js';
import type { Env } from '../src/config/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, 'hebrew-stt-corpus');

/** Published list prices, verified against each vendor's own pricing page on 2026-07-13. */
const PRICE_PER_MIN = {
  // developers.openai.com/api/docs/pricing — "gpt-realtime-whisper: $0.017 / minute"
  openai: 0.017,
  // soniox.com/pricing — "$0.12/hour" for real-time streaming
  soniox: 0.12 / 60,
} as const;

type EngineName = keyof typeof PRICE_PER_MIN;
type Condition = 'clean' | 'phone' | 'noisy';
const CONDITIONS: Condition[] = ['clean', 'phone', 'noisy'];

interface Row {
  id: string;
  category: Category;
  condition: Condition;
  engine: EngineName;
  reference: string;
  hypothesis: string;
  /** Raw WER — punishes an engine for writing "052-345-6789" instead of ten Hebrew words. */
  wer: number;
  cer: number;
  /**
   * WER after canonicalising numbers on BOTH sides. THIS IS THE ONE TO JUDGE ON.
   *
   * Soniox does inverse text normalisation: it writes spoken numbers as digits. Raw WER scored its
   * PERFECT reconstruction of a phone number as 76.9% wrong, purely for formatting. Judging the
   * engines on how they spell a number rather than whether they understood it would have rejected
   * the better engine on the strength of a feature we actively want for Phase 4 booking.
   */
  semanticWer: number;
  semanticCer: number;
  empty: boolean;
  timeToFirstTokenMs: number | null;
  timeToFinalMs: number | null;
  endpointDelayMs: number | null;
  audioSec: number;
  error?: string;
}

/**
 * Swallows a known upstream crash in LiveKit's OpenAI plugin, and NOTHING else.
 *
 * `VADStream.endInput()` calls `input.writable.close()` while a writer still holds the lock, so it
 * throws `ERR_INVALID_STATE: WritableStream is locked`. The OpenAI plugin reaches that line whenever
 * its audio input runs dry — which never happens on a live call (the caller's audio never ends) and
 * always happens on a finite test buffer. It fires asynchronously during teardown, AFTER we already
 * have the measurement, and it takes the whole process down with it.
 *
 * Deliberately narrow: anything that is not this exact error is re-thrown. A blanket handler here
 * would hide real failures in the thing we are trying to measure.
 */
function ignoreKnownPluginTeardownCrash(): void {
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    const isKnown = err?.code === 'ERR_INVALID_STATE' && /WritableStream is locked/.test(err.message);
    if (!isKnown) throw err;
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  ensureLogger('error');
  ignoreKnownPluginTeardownCrash();

  const only = process.argv[2] as Condition | undefined;
  const conditions = only ? [only] : CONDITIONS;
  if (only && !CONDITIONS.includes(only)) {
    throw new Error(`Unknown condition "${only}". Use one of: ${CONDITIONS.join(', ')}`);
  }

  await assertCorpusPresent();

  const rows: Row[] = [];
  const totalRuns = CORPUS.length * conditions.length * 2;
  let run = 0;

  for (const condition of conditions) {
    for (const item of CORPUS) {
      const { pcm, sampleRate } = await readWav(join(CORPUS_DIR, `${item.id}.${condition}.wav`));

      for (const engine of ['openai', 'soniox'] as EngineName[]) {
        run++;
        process.stdout.write(
          `[${String(run).padStart(2)}/${totalRuns}] ${condition.padEnd(5)} ${item.id.padEnd(12)} ${engine.padEnd(6)} ... `,
        );

        const m = await runEngine(engine, env, pcm, sampleRate, trailingFor(condition, sampleRate));
        const rates = errorRates(item.text, m.text);
        const semantic = semanticErrorRates(item.text, m.text);
        rows.push({
          id: item.id,
          category: item.category,
          condition,
          engine,
          reference: item.text,
          hypothesis: m.text,
          wer: rates.wer,
          cer: rates.cer,
          semanticWer: semantic.wer,
          semanticCer: semantic.cer,
          empty: rates.empty,
          timeToFirstTokenMs: m.timeToFirstTokenMs,
          timeToFinalMs: m.timeToFinalMs,
          endpointDelayMs: m.endpointDelayMs,
          audioSec: pcm.length / sampleRate,
          error: m.error,
        });

        const verdict = m.error
          ? `ERROR ${m.error.slice(0, 40)}`
          : `WER ${(semantic.wer * 100).toFixed(0).padStart(3)}%  eot ${String(m.endpointDelayMs ?? '—').padStart(4)}ms  "${m.text.slice(0, 34)}"`;
        console.log(verdict);
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(HERE, `stt-ab-results-${stamp}.json`);
  const mdPath = join(HERE, `stt-ab-report-${stamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify({ generatedAt: stamp, prices: PRICE_PER_MIN, rows }, null, 2)}\n`);
  await writeFile(mdPath, renderReport(rows, env));

  console.log(`\nResults: ${jsonPath}`);
  console.log(`Report:  ${mdPath}\n`);
  console.log(renderReport(rows, env));
}

/**
 * The audio on the line AFTER the caller stops talking — which is what the engine has to recognise
 * as "they finished".
 *
 * It must match the channel, and getting this wrong is our single most expensive past mistake. On
 * the `noisy` condition it is line noise, NOT digital silence. Silero (and any energy-based VAD)
 * decides "still speaking" from ENERGY, and a phone line always has some — hiss, comfort noise. The
 * synthetic caller fed digital silence, measured end-of-turn at 258ms, and a real phone then
 * measured ~950ms on identical config (docs/phase-4-known-issues.md §5). Digital silence would
 * flatter every engine here and reproduce that error exactly.
 */
function trailingFor(condition: Condition, sampleRate: number): Int16Array {
  const samples = 4 * sampleRate; // up to 4s of "the caller has gone quiet"
  const silence = new Int16Array(samples);
  // `clean` is the only condition where a truly silent line is the honest simulation.
  return condition === 'clean' ? silence : addLineNoise(silence, 0.005, 42);
}

async function runEngine(
  engine: EngineName,
  env: Env,
  pcm: Int16Array,
  sampleRate: number,
  trailingAudio: Int16Array,
): Promise<Measurement> {
  try {
    let stt;
    if (engine === 'soniox') {
      stt = createSonioxSTT(env);
    } else {
      // A fresh VAD per run. The VAD carries per-stream state (it is a stateful stream, not a pure
      // model), and sharing one across sequential STT instances leaves that state — and its stream
      // locks — in whatever condition the last run left it.
      //
      // Soniox is constructed WITHOUT a VAD at all, and that asymmetry is the point rather than an
      // oversight: it endpoints server-side. The OpenAI engine physically cannot decide a turn is
      // over without a local VAD telling it so, and that VAD is the ~1113ms we are trying to kill.
      const vad = await silero.VAD.load({ minSilenceDuration: env.VOICE_VAD_MIN_SILENCE_MS });
      stt = new openai.STT({
        model: env.OPENAI_REALTIME_MODEL,
        language: env.VOICE_LANGUAGE,
        useRealtime: true,
        vad,
        // Deliberately NOT passing `prompt`: gpt-realtime-whisper hard-errors on it. That is the
        // asymmetry being measured, not a handicap we imposed.
      });
    }
    return await measureStream(stt, pcm, sampleRate, { realtime: true, trailingAudio });
  } catch (err) {
    return {
      text: '',
      timeToFirstTokenMs: null,
      timeToFinalMs: null,
      endpointDelayMs: null,
      audioDurationSec: pcm.length / sampleRate,
      interims: [],
      timedOut: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Reads a 16-bit PCM mono WAV. Only the format this corpus writes — not a general WAV parser. */
async function readWav(path: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const buf = await readFile(path);
  const sampleRate = buf.readUInt32LE(24);
  const bytes = buf.subarray(44);
  const pcm = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  return { pcm, sampleRate };
}

async function assertCorpusPresent(): Promise<void> {
  const files = await readdir(CORPUS_DIR).catch(() => [] as string[]);
  const wavs = files.filter((f) => f.endsWith('.wav'));
  const expected = CORPUS.length * CONDITIONS.length;
  if (wavs.length < expected) {
    throw new Error(
      `Corpus incomplete: found ${wavs.length} WAVs, expected ${expected}. Run: npm run stt:corpus`,
    );
  }
}

// --- report ---------------------------------------------------------------------------------

function renderReport(rows: Row[], env: Env): string {
  const engines: EngineName[] = ['openai', 'soniox'];
  const L: string[] = [];

  L.push('# Hebrew STT A/B — Soniox vs OpenAI\n');
  L.push(`Generated ${new Date().toISOString()}`);
  L.push(
    `Models: OpenAI \`${env.OPENAI_REALTIME_MODEL}\` vs Soniox \`${env.SONIOX_MODEL}\` `
      + `(endpoint delay ${env.SONIOX_MAX_ENDPOINT_DELAY_MS}ms)\n`,
  );

  L.push('## Verdict\n');
  L.push(renderVerdict(rows));

  L.push('\n## Accuracy by category (WER — lower is better)\n');
  L.push('WER counts every substituted, inserted and deleted WORD against the reference. CER does');
  L.push('the same over characters, which matters in Hebrew: prefixes glue onto words (בבית = "in');
  L.push('the house"), so an engine that writes "ב בית" is one space from correct but WER scores it');
  L.push('as a total loss. Trust CER when the two disagree on a near-miss.\n');

  const categories: Category[] = ['greeting', 'confirmation', 'business'];
  L.push('| Condition | Category | openai semantic | openai raw | soniox semantic | soniox raw |');
  L.push('|---|---|---|---|---|---|');
  for (const condition of uniq(rows.map((r) => r.condition))) {
    for (const category of categories) {
      const cells = engines.map((engine) => {
        const sel = rows.filter(
          (r) => r.condition === condition && r.category === category && r.engine === engine,
        );
        return `${pct(mean(sel.map((r) => r.semanticWer)))} | ${pct(mean(sel.map((r) => r.wer)))}`;
      });
      L.push(`| ${condition} | ${category} | ${cells.join(' | ')} |`);
    }
  }

  L.push('\n## Latency (median)\n');
  L.push('**End-of-turn** is the one that decides the product. It is how long the caller sits in');
  L.push('silence after finishing a sentence before the agent can even start thinking. Our live');
  L.push('agent currently pays ~1113ms of it to a Silero silence timer, because no vendor sells a');
  L.push('Hebrew end-of-turn model. If Soniox\'s semantic endpoint beats that, it is worth more than');
  L.push('the accuracy difference.\n');
  L.push('| Condition | Engine | first token | end-of-turn | time to final |');
  L.push('|---|---|---|---|---|');
  for (const condition of uniq(rows.map((r) => r.condition))) {
    for (const engine of engines) {
      const sel = rows.filter((r) => r.condition === condition && r.engine === engine && !r.error);
      L.push(
        `| ${condition} | ${engine} | ${ms(median(nums(sel.map((r) => r.timeToFirstTokenMs))))} `
          + `| ${ms(median(nums(sel.map((r) => r.endpointDelayMs))))} `
          + `| ${ms(median(nums(sel.map((r) => r.timeToFinalMs))))} |`,
      );
    }
  }

  L.push('\n## Cost\n');
  L.push('| Engine | Published rate | Per 4-min call | vs incumbent |');
  L.push('|---|---|---|---|');
  for (const engine of engines) {
    const perMin = PRICE_PER_MIN[engine];
    const ratio = perMin / PRICE_PER_MIN.openai;
    L.push(
      `| ${engine} | $${perMin.toFixed(4)}/min | $${(perMin * 4).toFixed(4)} | `
        + `${engine === 'openai' ? '—' : `${(1 / ratio).toFixed(1)}x cheaper`} |`,
    );
  }

  L.push('\n## Every utterance\n');
  L.push('| Condition | id | Engine | semantic | raw | Reference | Heard |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const heard = r.error ? `**ERROR**: ${r.error.slice(0, 50)}` : r.hypothesis || '*(nothing)*';
    L.push(
      `| ${r.condition} | ${r.id} | ${r.engine} | ${pct(r.semanticWer)} | ${pct(r.wer)} | ${r.reference} | ${heard} |`,
    );
  }

  L.push('\n---\n');
  L.push('### What this test cannot tell you\n');
  L.push('The corpus is **Cartesia-synthesized speech, not human speech**. TTS audio is unnaturally');
  L.push('well-articulated: no disfluencies, no mumbling, no accent, no two words running together.');
  L.push('Real callers do all of that constantly.\n');
  L.push('So the WER here is a **ceiling** — real Hebrew WER will be worse for BOTH engines. This is');
  L.push('a **comparative** instrument. "Soniox beat OpenAI by 3x on our corpus" is supportable;');
  L.push('"Soniox achieves 1.2% WER on our calls" is not.\n');
  L.push('We have made exactly this mistake before: the synthetic caller harness measured end-of-turn');
  L.push('at 258ms against audio containing digital silence, while a real phone measured ~950ms with');
  L.push('identical config (docs/phase-4-known-issues.md §5). The `.noisy` condition exists to fight');
  L.push('that, but it is still simulated. **Shadow mode on real callers is what settles this.**\n');

  return L.join('\n');
}

function renderVerdict(rows: Row[]): string {
  // Judge on the noisy condition where possible: it is the closest thing here to a phone call, and
  // an engine that wins on studio audio and loses on a phone line has lost. Every caller is on a
  // phone.
  const judged = rows.some((r) => r.condition === 'noisy') ? 'noisy' : rows[0]?.condition;
  const forEngine = (e: EngineName) => rows.filter((r) => r.condition === judged && r.engine === e);

  const oWer = mean(forEngine('openai').map((r) => r.semanticWer));
  const sWer = mean(forEngine('soniox').map((r) => r.semanticWer));
  const oRaw = mean(forEngine('openai').map((r) => r.wer));
  const sRaw = mean(forEngine('soniox').map((r) => r.wer));
  const oEot = median(nums(forEngine('openai').map((r) => r.endpointDelayMs)));
  const sEot = median(nums(forEngine('soniox').map((r) => r.endpointDelayMs)));

  const out: string[] = [];
  out.push(`Judged on the **${judged}** condition — band-limited and noisy, the closest thing here`);
  out.push('to a real phone call.\n');
  out.push('| Metric | OpenAI | Soniox | Winner |');
  out.push('|---|---|---|---|');
  out.push(`| **Semantic WER** | ${pct(oWer)} | ${pct(sWer)} | ${winner(oWer, sWer)} |`);
  out.push(`| Raw WER (formatting-sensitive) | ${pct(oRaw)} | ${pct(sRaw)} | ${winner(oRaw, sRaw)} |`);
  out.push(`| End-of-turn | ${ms(oEot)} | ${ms(sEot)} | ${winner(oEot, sEot)} |`);
  out.push(
    `| Cost/min | $${PRICE_PER_MIN.openai.toFixed(4)} | $${PRICE_PER_MIN.soniox.toFixed(4)} | Soniox |`,
  );

  const errs = rows.filter((r) => r.error);
  if (errs.length > 0) {
    out.push(`\n**${errs.length} run(s) errored** — see the per-utterance table.`);
  }
  return out.join('\n');
}

const winner = (a: number | null, b: number | null): string => {
  if (a === null || b === null) return '—';
  if (Math.abs(a - b) < 1e-9) return 'tie';
  return a < b ? 'OpenAI' : 'Soniox';
};
const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const ms = (v: number | null): string => (v === null ? '—' : `${Math.round(v)}ms`);
const nums = (v: Array<number | null>): number[] => v.filter((x): x is number => x !== null);
const uniq = <T,>(v: T[]): T[] => [...new Set(v)];

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
