/**
 * sonic-3 vs sonic-3.5: time-to-first-audio, INTERLEAVED.
 *
 * WHY THIS EXISTS ALONGSIDE `bench:tts`. That harness measures each candidate in a BLOCK — all of
 * model A, then all of model B. Any drift in network conditions during the run is therefore
 * indistinguishable from a difference between the models, and it bit us immediately: a run on
 * 2026-08-05 put live sonic-3 at 1351ms against its own documented ~455ms, which would have made
 * sonic-3.5 look 862ms faster than it is.
 *
 * This alternates A,B,A,B,… so slow drift hits both arms equally, and reports the MEDIAN and the
 * SPREAD of each arm. If the arms' spreads overlap, there is no result — say so rather than
 * reporting the difference of two medians as if it were a finding.
 *
 * TTFB is what matters, not total synthesis time: the caller hears the first syllable and stops
 * waiting. Measured as time to the first audio FRAME off the websocket, which is exactly what the
 * live agent waits for.
 *
 * Usage:
 *   npm run voice:model-ab
 *   npm run voice:model-ab -- --rounds 8 --voice <id>
 */
import { tts as ttsBase } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import { loadEnv } from '../../../../config/env.js';
import { cartesiaOptions, ensureLogger } from './speech.js';

const env = loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const MODELS = ['sonic-3', 'sonic-3.5'] as const;
const ROUNDS = Number(arg('rounds') ?? 6);
const VOICE = arg('voice') ?? env.CARTESIA_VOICE_ID_PRIMARY;

/** A real agent reply, not a test phrase — length and phrasing drive TTFB. */
const LINE = 'בשמחה, אנחנו עוזרים לעסקים להביא יותר לידים דרך קידום ממומן ואוטומציות. רוצה שאקבע לך שיחה עם קורן?';

if (!VOICE) throw new Error('no voice: pass --voice <id> or set CARTESIA_VOICE_ID_PRIMARY');

ensureLogger();

/**
 * One synthesis, returning ms to the FIRST audio frame.
 *
 * The TTS object is reused across rounds per model, mirroring the live agent (which builds one per
 * call and streams every turn through it) — a fresh socket per measurement would measure connection
 * setup, which the agent pays once and the caller never hears per turn.
 */
async function ttfb(tts: cartesia.TTS): Promise<number> {
  const stream = tts.stream();
  const startedAt = performance.now();
  stream.pushText(LINE);
  stream.flush();
  stream.endInput();

  let first: number | null = null;
  for await (const ev of stream) {
    if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
    if (first === null) first = performance.now() - startedAt;
  }
  stream.close();
  if (first === null) throw new Error('zero audio frames — a rejected parameter, not a slow model');
  return Math.round(first);
}

const engines = new Map<string, cartesia.TTS>();
for (const model of MODELS) {
  engines.set(model, new cartesia.TTS(cartesiaOptions(env, { voice: VOICE, model })));
}

const samples: Record<string, number[]> = { 'sonic-3': [], 'sonic-3.5': [] };

// Discarded warm-up per arm: the first call on a cold socket measures the TCP+TLS handshake.
for (const model of MODELS) await ttfb(engines.get(model)!);

console.log(`voice=${VOICE.slice(0, 8)}…  rounds=${ROUNDS}  interleaved A/B/A/B\n`);
for (let round = 0; round < ROUNDS; round++) {
  // Alternate the ORDER each round too, so a systematic within-round position effect (the second
  // request of a pair benefiting from a warmed path) cannot accumulate into one arm.
  const order = round % 2 === 0 ? MODELS : [...MODELS].reverse();
  const line: string[] = [];
  for (const model of order) {
    const ms = await ttfb(engines.get(model)!);
    samples[model]!.push(ms);
    line.push(`${model}=${String(ms).padStart(4)}ms`);
  }
  console.log(`  round ${round + 1}  ${line.join('  ')}`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log('\n--- results ---');
const med: Record<string, number> = {};
for (const model of MODELS) {
  const s = samples[model]!;
  med[model] = median(s);
  console.log(`  ${model.padEnd(10)} median ${String(med[model]).padStart(4)}ms   min ${Math.min(...s)}  max ${Math.max(...s)}`);
}

const diff = med['sonic-3']! - med['sonic-3.5']!;
const overlap =
  Math.min(...samples['sonic-3']!) <= Math.max(...samples['sonic-3.5']!) &&
  Math.min(...samples['sonic-3.5']!) <= Math.max(...samples['sonic-3']!);

console.log('');
if (overlap) {
  // Two medians always differ by something. Saying so without saying the ranges overlap is how a
  // production model gets swapped on noise.
  console.log(`  RANGES OVERLAP — median gap is ${Math.abs(diff)}ms but the arms are not separated.`);
  console.log('  Not a latency result. Choose on Hebrew quality (listen), or raise --rounds.');
} else {
  console.log(`  SEPARATED — ${diff > 0 ? 'sonic-3.5' : 'sonic-3'} is ${Math.abs(diff)}ms faster, ranges do not overlap.`);
}
console.log('\n  Offline TTFB only. The number a caller feels also carries endpointing + LLM;');
console.log('  compare real calls with: node scripts/call-stats.mjs --by-model');
process.exit(0);
