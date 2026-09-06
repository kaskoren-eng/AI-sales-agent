/**
 * Latency bench — hunt down the ~1.8s worst-case response time.
 *
 *   npm run bench:tts     time-to-first-AUDIO for every Hebrew-capable TTS
 *   npm run bench:llm     time-to-first-TOKEN for every candidate LLM, on our real prompt
 *   npm run bench:path    WHERE the reply is held before she starts speaking (guard vs downstream)
 *   npm run bench:tier    is VOICE_LLM_SERVICE_TIER=priority worth ~2x the token price?
 *   npm run bench:ttft    what the model's first token actually depends on (prompt size? tail? cache?)
 *
 * WHAT WE ARE ACTUALLY OPTIMISING. After the caller stops speaking he waits through three things:
 *
 *   end-of-turn   ~400ms   deciding he finished          (Soniox endpoint, delay 1000ms)
 *   LLM ttft      ~974ms   GPT thinking                  (the dominant term — and irreducible)
 *   TTS ttfb      ~217ms   the voice starting to speak   (Cartesia sonic-3.5 in prod — HISTORICAL,
 *                                                         pre-2026-09-02; no cloud DeepDub ttfb
 *                                                         has ever been recorded)
 *
 * SINCE 2026-09-02 THE TTS ARM FOLLOWS `VOICE_TTS_PROVIDER` rather than assuming Cartesia, and it
 * carries a DeepDub arm alongside the Cartesia ones. The row matching the configured engine is
 * marked `(LIVE)` and is the baseline every delta is measured against — so flipping the provider
 * moves the baseline instead of silently ranking everything against an engine we stopped using.
 *
 * RE-MEASURED 2026-08-16, and the conclusion changed. The old note here said preemptive generation
 * hid the LLM and preemptive TTS hid Cartesia. Neither survives contact with Soniox (known-issues
 * §14), and `bench:llm` finds NO faster model — gpt-5.4 at 808ms beats gemini-3-flash, both
 * minis, and grok-non-reasoning. So ~1.6s is the floor for a real ANSWER, and the sub-second
 * number comes from VOICE_INSTANT_ACK speaking before the model does, not from a faster stage.
 *
 * WHY THIS BENCH AND NOT A PHONE CALL. A real call costs Koren's time and gives one sample of one
 * config. This measures every candidate, several times each, in a couple of minutes, for cents —
 * and then he only has to make ONE call, to confirm the winner. Judge candidates here; never
 * BELIEVE anything here until a real call agrees (the synthetic-caller harness taught us that, at
 * length: docs/phase-4-known-issues.md §5).
 *
 * TTFB is measured to the first audio FRAME, not to the end of synthesis — the caller starts
 * hearing her at the first frame, and that is the number he feels.
 */
import { inference, initializeLogger, llm as llmBase, tts as ttsBase } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { loadEnv } from '../../../../config/env.js';
import { HarnessVoice, describeEngine, type EngineOverride } from './tts-engine.js';
import { SYSTEM_PROMPT_HE } from '../prompts/system-prompt.he.js';
import { buildSystemPrompt } from '../prompts/system-prompt.he.js';
import { buildAgentTools } from '../tools/index.js';
import { guardStream } from '../speech-guard.js';
import { toPhoneWav, toStudioWav } from './wav.js';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Env } from '../../../../config/env.js';

/** A real reply, the length she actually speaks. Benchmarking on "hello" measures nothing. */
const HEBREW_LINE =
  'בשמחה, אנחנו עוזרים לעסקים להביא יותר לידים דרך קידום ממומן ואוטומציות. רוצה שאקבע לך שיחה עם קורן?';

/** What a caller actually says, mid-conversation, to make the LLM benchmark honest. */
const HEBREW_TURN = 'תגידי, כמה זה עולה ואיך אתם יכולים לעזור לי עם הלידים שלי?';

/**
 * Measurements per arm; the median is reported. `--runs=1` cuts a full run to roughly a third.
 *
 * A FLAG AND NOT AN ENV VAR, for the reason every knob in this harness is a flag: `loadEnv()` runs
 * dotenv with `override: true`, so `RUNS=1 npm run bench:tts` would be a silent no-op.
 *
 * Why it exists: with the DeepDub realtime-on and realtime-off arms added, a full run passed the
 * ten-minute budget a session had allowed for it (2026-09-02) and returned nothing at all — the
 * arms are sequential, so a timeout costs every row, not the last one. One run per arm is enough
 * to answer "does this engine produce audio at a sane latency"; three is for RANKING engines
 * against each other, which is the only thing this bench's absolute numbers are good for anyway
 * (see the warning above).
 */
const RUNS = (() => {
  const flag = process.argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length);
  if (flag === undefined) return 3;
  const n = Number(flag);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--runs=${flag} must be a positive integer`);
  return n;
})();
const OUT_DIR = 'voice-samples/bench';

/**
 * ⚠️ `bench:tts` ABSOLUTE NUMBERS DO NOT MATCH PRODUCTION. Read it for RANKING only.
 *
 * Run 2026-08-16: the live config (direct Cartesia) measured **1637ms** here against **217ms** on
 * real calls the same day — a 7x disagreement. The bench pushes one long line and flushes, while a
 * real turn streams a short first sentence into an already-open socket. Same trap as the LLM arm,
 * which "proved" gpt-5.4-mini was faster and then lost on a real call (known-issues §3): a bench
 * whose input does not match production measures a call that never happens.
 *
 * Also on that run, EVERY `inference.TTS` row returned NO AUDIO while the direct row worked. The
 * printed hint blames a missing voice id, and for these rows that is wrong — the voice is passed.
 * It is the LiveKit inference gateway itself. Production does not use that path
 * (`VOICE_TTS_ROUTE=cartesia` goes direct), so it is a bench problem, not a live one.
 *
 * TTS is also the SMALLEST term in the budget (217ms of ~1.6s). Do not spend time here before
 * end-of-turn and the LLM.
 */

/**
 * How long one synthesis may take before the candidate is written off as hung.
 *
 * A real TTS answers in a few hundred ms. This is generous enough that a slow-but-working vendor
 * still scores, and short enough that a broken one costs a few seconds rather than the run —
 * `bench:tts` sat for 20+ minutes on a single ElevenLabs row on 2026-08-16 and returned nothing
 * for any of the candidates that would have come after it.
 */
const SYNTH_TIMEOUT_MS = 20_000;

/**
 * Drains a TTS stream, giving up if the vendor stops sending and never closes.
 *
 * `for await (const ev of stream)` cannot express this: an iterator that simply never resolves
 * hangs forever with no way out. Racing each `next()` against a timer is the only shape that can
 * abandon a dead stream, so it is worth the extra lines.
 */
async function drainWithTimeout(
  stream: AsyncIterable<{ frame: AudioFrame } | typeof ttsBase.SynthesizeStream.END_OF_STREAM>,
  started: number,
): Promise<{ ttfb: number | null; got: AudioFrame[]; timedOut: boolean }> {
  const iterator = stream[Symbol.asyncIterator]();
  const got: AudioFrame[] = [];
  let ttfb: number | null = null;

  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), SYNTH_TIMEOUT_MS);
      // Never hold the process open for a timer whose only job is to abandon something.
      timer.unref?.();
    });

    const next = await Promise.race([iterator.next(), deadline]);
    clearTimeout(timer);

    if (next === 'TIMEOUT') return { ttfb, got, timedOut: true };
    if (next.done) break;
    if (next.value === ttsBase.SynthesizeStream.END_OF_STREAM) break;
    ttfb ??= Date.now() - started;
    got.push((next.value as { frame: AudioFrame }).frame);
  }
  return { ttfb, got, timedOut: false };
}

// ---------------------------------------------------------------------------------------------
// TTS candidates. Hebrew is the filter that kills most of them: Deepgram Aura and Rime are
// English-only, so they are not here. A model that cannot speak Hebrew is not a fast model, it is
// a broken one — and we have been burned by exactly that (sonic-turbo returns EMPTY audio for
// Hebrew and only whispers about it at DEBUG level; known-issues §2).
// ---------------------------------------------------------------------------------------------
interface TtsCandidate {
  name: string;
  build: (env: Env) => ttsBase.TTS;
  /** Set when the model is known to be dubious on Hebrew — listen to the WAV before believing it. */
  note?: string;
  /**
   * `VOICE_TTS_PROVIDER` value this row exercises, when it is one of ours. Two jobs: it marks the
   * row that matches the CONFIGURED engine as the baseline, and it decides whether the row honours
   * VOICE_TTS_SPEED / VOICE_TTS_VOLUME.
   */
  provider?: EngineOverride['provider'];
  /** Whether the row was actually sent our speed/volume, so the table can say so per row. */
  honoursSpeedVolume?: boolean;
  /** Returns a reason to SKIP (missing credential, etc.), or null to run it. */
  skipIf?: (env: Env) => string | null;
}

/**
 * `close()` where a row owns a real engine — otherwise the row leaks its sockets.
 *
 * Cartesia's plugin opens a websocket per `stream()` and forgets it; DeepDub holds a POOL of two
 * for the life of the instance. Seven rows × a live pool each is how a bench ends by hanging on
 * exit instead of printing its ranking.
 */
const closers: Array<() => Promise<void>> = [];

function harnessRow(env: Env, override: EngineOverride): ttsBase.TTS {
  const voice = new HarnessVoice(env, override);
  closers.push(() => voice.close());
  // The bench drives the raw stream itself (it needs per-frame timing), so it wants the TTS, not
  // the wrapper. `HarnessVoice` exists to own the lifetime and the label.
  return voice.tts;
}

/**
 * ElevenLabs voices. A voice ID is REQUIRED — omitting it returns an EMPTY STREAM, not an error,
 * which reads exactly like "this model cannot speak Hebrew" and is nothing of the sort. That is the
 * same failure signature as sonic-turbo (known-issues §2), and it fooled the first run of this
 * bench. These are ElevenLabs' public multilingual voices; all of them speak Hebrew.
 */
const EL_VOICE_FEMALE = 'XB0fDUnXU5powFXDhCwa'; // Charlotte — female, multilingual
const EL_VOICE_ALT = '9BWtsMINqrJLrRacOk9x'; // Aria — female, multilingual

/**
 * The rows, built against the env so they name the models actually configured.
 *
 * THE BASELINE IS NO LONGER HARD-CODED TO CARTESIA. It is whichever row matches
 * `VOICE_TTS_PROVIDER`, marked `(LIVE)` at print time. Hard-coding it was fine while Cartesia was
 * the only thing we shipped, and would have quietly made the bench rank every engine against a
 * baseline we had stopped using the moment the provider flipped.
 *
 * DeepDub is an ARM, not a replacement: both engines stay on the table because putting them head
 * to head is the entire purpose of this command.
 */
function ttsCandidates(env: Env): TtsCandidate[] {
  const deepdubMissing = (e: Env): string | null =>
    !e.DEEPDUB_API_KEY
      ? 'DEEPDUB_API_KEY not set'
      : !e.DEEPDUB_VOICE_PROMPT_ID
        ? 'DEEPDUB_VOICE_PROMPT_ID not set'
        : null;

  return [
  {
    // Direct to Cartesia with our own key — the shipped Cartesia path.
    name: `cartesia/${env.CARTESIA_MODEL} (direct)`,
    provider: 'cartesia',
    honoursSpeedVolume: true,
    build: (e) => harnessRow(e, { provider: 'cartesia', route: 'cartesia' }),
  },
  {
    // DeepDub on the REALTIME model — the path the adapter is built around, and the one that beat
    // Cartesia 5/5 on Koren's ear in round 22.
    //
    // ⚠ THE ABSOLUTE NUMBERS HERE ARE THIS LAPTOP'S, NOT PRODUCTION'S. Measured 2026-09-02 on a
    // fair local harness: DeepDub warm median TTFB 466ms against Cartesia's 1236ms — while the
    // same day's production call reports put Cartesia at 223-259ms. Local absolutes are dominated
    // by this machine's round-trip to the vendor. Read the RANKING; never quote the number.
    name: `deepdub/${env.DEEPDUB_MODEL} (realtime)`,
    provider: 'deepdub',
    honoursSpeedVolume: false,
    skipIf: deepdubMissing,
    build: (e) => harnessRow(e, { provider: 'deepdub', env: { DEEPDUB_REALTIME: true } }),
  },
  {
    // The same engine with realtime OFF, purely to price the flag. If this is not materially
    // slower, the flag is not buying what its comment claims.
    name: `deepdub/${env.DEEPDUB_MODEL} (realtime OFF)`,
    provider: 'deepdub',
    honoursSpeedVolume: false,
    skipIf: deepdubMissing,
    build: (e) => harnessRow(e, { provider: 'deepdub', env: { DEEPDUB_REALTIME: false } }),
  },
  {
    // Same model through LiveKit's gateway. Included ONLY to price the extra hop: if this is much
    // slower than the row above, every other inference row carries that same handicap and must be
    // judged accordingly.
    name: 'cartesia/sonic-3 (via inference)',
    build: (env) =>
      new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: env.CARTESIA_VOICE_ID_PRIMARY,
        language: 'he',
      }),
  },
  {
    // NEW since our notes were written: known-issues §2 says "there is no sonic-4", which is true —
    // but sonic-3.5 has appeared.
    //
    // THE NAME MUST SAY `(via inference)`. It did not until 2026-09-02, and on that run the table
    // showed `cartesia/sonic-3.5` at 334ms and `cartesia/sonic-3.5 (direct)` at 1239ms — the same
    // provider and the same model, 3.7x apart, with nothing on either row to say they came down
    // different wires. A reader reasonably concluded the LIVE baseline was broken, and the LIVE
    // baseline is what every other row's delta is measured against. The gap is the LiveKit
    // gateway hop (see the ⚠ block at the top); the rows were never comparable.
    name: 'cartesia/sonic-3.5 (via inference)',
    build: (env) =>
      new inference.TTS({
        model: 'cartesia/sonic-3.5',
        voice: env.CARTESIA_VOICE_ID_PRIMARY,
        language: 'he',
      }),
  },
  {
    // The fastest TTS on the market by reputation (~75ms model latency). Hebrew is among Flash
    // v2.5's languages. The row most likely to win.
    // `language_code` goes in modelOptions — ElevenLabs does NOT read the top-level `language`.
    name: 'elevenlabs/eleven_flash_v2_5',
    build: () =>
      new inference.TTS({
        model: 'elevenlabs/eleven_flash_v2_5',
        voice: EL_VOICE_FEMALE,
        modelOptions: { language_code: 'he', auto_mode: true },
      }),
  },
  {
    name: 'elevenlabs/eleven_turbo_v2_5',
    build: () =>
      new inference.TTS({
        model: 'elevenlabs/eleven_turbo_v2_5',
        voice: EL_VOICE_FEMALE,
        modelOptions: { language_code: 'he', auto_mode: true },
      }),
  },
  {
    name: 'elevenlabs/eleven_flash_v2_5 (Aria)',
    build: () =>
      new inference.TTS({
        model: 'elevenlabs/eleven_flash_v2_5',
        voice: EL_VOICE_ALT,
        modelOptions: { language_code: 'he', auto_mode: true },
      }),
  },
  {
    name: 'elevenlabs/eleven_multilingual_v2',
    build: () =>
      new inference.TTS({
        model: 'elevenlabs/eleven_multilingual_v2',
        voice: EL_VOICE_FEMALE,
        modelOptions: { language_code: 'he' },
      }),
    note: 'quality-first model — expect it to be slower',
  },
  ];
}

// ---------------------------------------------------------------------------------------------
// LLM candidates. Measured on the REAL system prompt and a REAL Hebrew turn, because ttft depends
// on how much you make the model read first.
//
// A previous sweep concluded "there is no faster LLM" (gpt-5-nano was SLOWER than gpt-5.4). That
// sweep only tried the gpt-5 family. It never tried Gemini Flash or Grok's non-reasoning models,
// which are built for exactly this.
// ---------------------------------------------------------------------------------------------
interface LlmCandidate {
  name: string;
  build: (env: Env) => llmBase.LLM;
  note?: string;
}

const LLM_CANDIDATES: LlmCandidate[] = [
  {
    name: 'openai/gpt-5.4 effort=none (LIVE, direct)',
    build: (env) =>
      new openai.LLM({ model: env.VOICE_LLM_MODEL ?? env.AI_MODEL, reasoningEffort: 'none' }),
  },
  { name: 'openai/gpt-5.4-mini', build: () => new inference.LLM({ model: 'openai/gpt-5.4-mini' }) },
  { name: 'openai/gpt-4.1-mini', build: () => new inference.LLM({ model: 'openai/gpt-4.1-mini' }) },
  {
    // Gemini Flash is fast AND genuinely good at Hebrew — the most promising row here.
    name: 'google/gemini-3.5-flash',
    build: () => new inference.LLM({ model: 'google/gemini-3.5-flash' }),
  },
  { name: 'google/gemini-3-flash', build: () => new inference.LLM({ model: 'google/gemini-3-flash' }) },
  {
    name: 'google/gemini-3.1-flash-lite',
    build: () => new inference.LLM({ model: 'google/gemini-3.1-flash-lite' }),
  },
  {
    // "non-reasoning" is the point: no thinking tokens before the first word.
    name: 'xai/grok-4-1-fast-non-reasoning',
    build: () => new inference.LLM({ model: 'xai/grok-4-1-fast-non-reasoning' }),
  },
];

async function benchTts(env: Env): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const live = describeEngine(env);
  console.log(`TTS — time to FIRST AUDIO on a real Hebrew reply (${RUNS} runs each, median)\n`);
  console.log(`  "${HEBREW_LINE}"\n`);
  console.log(`  configured engine (VOICE_TTS_PROVIDER): ${live.label} — marked (LIVE) below\n`);
  console.log(
    `  speed/volume: VOICE_TTS_SPEED=${env.VOICE_TTS_SPEED} VOICE_TTS_VOLUME=${env.VOICE_TTS_VOLUME}\n` +
      `  reach CARTESIA rows ONLY. DeepDub and ElevenLabs are sent neither, so their rows are at\n` +
      `  the engine's own rate and level — a difference that is NOT a difference in those knobs.\n`,
  );

  const results: Array<{
    name: string;
    ttfb: number | null;
    note?: string;
    err?: string;
    skipped?: string;
    isLive?: boolean;
  }> = [];

  for (const c of ttsCandidates(env)) {
    const isLive = c.provider !== undefined && c.provider === live.provider;
    const displayName = `${c.name}${isLive ? ' (LIVE)' : ''}`;

    const skip = c.skipIf?.(env) ?? null;
    if (skip) {
      // A SKIPPED ROW IS NOT A SLOW ROW. Printing it as a failure would read as "DeepDub is
      // broken" when the truth is "this laptop has no DeepDub key".
      results.push({ name: displayName, ttfb: null, skipped: skip, isLive });
      console.log(`  ${displayName.padEnd(38)} skipped — ${skip}`);
      continue;
    }

    const samples: number[] = [];
    let frames: AudioFrame[] = [];
    let err: string | undefined;

    // ONE TTS instance, reused — exactly as the live agent holds one for the whole call. Building a
    // fresh one per run measures TCP + TLS + websocket handshake on every sample, which put the
    // baseline at 1411ms here against 455ms on a real call. That is not the number the caller feels.
    const tts = c.build(env);

    // Warm-up run, discarded. The first synthesis pays the connection cost; every turn after it on
    // a real call does not.
    // RUNS+1 iterations, and iteration 0 is thrown away.
    for (let i = 0; i <= RUNS; i++) {
      try {
        const stream = tts.stream();
        const started = Date.now();
        stream.pushText(HEBREW_LINE);
        stream.flush();
        stream.endInput();

        const { ttfb, got, timedOut } = await drainWithTimeout(stream, started);
        stream.close();

        if (timedOut) {
          // A CANDIDATE THAT HANGS MUST NOT TAKE THE BENCH WITH IT. On 2026-08-16 this run sat for
          // 20+ minutes on one row and produced nothing at all for the six that would have
          // followed — so the answer to "which TTS is fastest" was lost to a vendor that simply
          // never closed its stream. An empty result for one row is a finding; no results is not.
          err = `HUNG — no end-of-stream after ${SYNTH_TIMEOUT_MS}ms (vendor never closed it)`;
          break;
        }
        if (got.length === 0) {
          // AN EMPTY STREAM IS A BUG IN OUR REQUEST, NOT PROOF THE MODEL CANNOT SPEAK HEBREW.
          // This is the single most expensive lesson in this codebase (known-issues §2): sonic-turbo
          // returns a 44-byte WAV header and no samples when it dislikes a parameter, logging only
          // at DEBUG. The first run of this bench "proved" that ElevenLabs, Inworld and sonic-3.5
          // all reject Hebrew. In fact ElevenLabs simply requires a voice ID, which was missing.
          err = 'NO AUDIO — check the request (a missing/invalid voice id does this), not the model';
          break;
        }
        if (i > 0 && ttfb !== null) samples.push(ttfb); // i === 0 is the warm-up
        if (i === 1) frames = got;
      } catch (e) {
        err = e instanceof Error ? e.message.slice(0, 90) : String(e);
        break;
      }
    }

    const ttfb = median(samples);
    results.push({ name: displayName, ttfb, note: c.note, err, isLive });

    if (frames.length > 0) {
      // Judge the voice on the PHONE band, never on studio audio — an 8kHz line strips the
      // frequencies that carry Hebrew consonants, and a voice that is lovely in a browser can be
      // unintelligible on a call. That is not hypothetical; it is what happened to us.
      //
      // The candidate NAME is the filename, and every name starts with its provider — so a WAV
      // found later in voice-samples/bench/ still says which engine made it.
      const safe = displayName.replace(/[^a-z0-9.]+/gi, '_');
      await writeFile(`${OUT_DIR}/${safe}-phone.wav`, toPhoneWav(frames));
      await writeFile(`${OUT_DIR}/${safe}-studio.wav`, toStudioWav(frames));
    }

    // The speed/volume column, per row, because the alternative is a reader assuming the levers
    // applied everywhere and concluding they do nothing.
    const levers =
      c.honoursSpeedVolume === undefined
        ? ''
        : c.honoursSpeedVolume
          ? `   [speed/volume applied]`
          : `   [speed/volume IGNORED by this engine]`;
    console.log(
      `  ${displayName.padEnd(38)} ${err ? `FAILED — ${err}` : `${String(ttfb).padStart(4)}ms`}` +
        `${levers}${c.note ? `   (${c.note})` : ''}`,
    );
  }

  // The baseline is the CONFIGURED engine, whatever that is today — not a hard-coded Cartesia row.
  const baseline = results.find((r) => r.isLive && r.ttfb !== null)?.ttfb;
  console.log('\n  --- ranked (working models only) ---');
  for (const r of results.filter((r) => !r.err && !r.skipped && r.ttfb !== null).sort((a, b) => a.ttfb! - b.ttfb!)) {
    const delta = baseline ? r.ttfb! - baseline : 0;
    const tag = !baseline || delta === 0 ? '' : delta < 0 ? `  ${delta}ms FASTER` : `  +${delta}ms slower`;
    console.log(`  ${String(r.ttfb).padStart(4)}ms  ${r.name}${tag}`);
  }
  if (!baseline) {
    console.log(`  (no baseline: no row for the configured engine ${live.label} produced audio)`);
  }
  console.log(`\n  Samples in ${OUT_DIR}/ — LISTEN TO THE -phone.wav FILES BEFORE CHOOSING.`);
  console.log('  A fast voice that is unintelligible down a phone line is not a win.');
  console.log(
    '  And these are LOCAL absolutes from this laptop — production TTS TTFB on the same day was\n' +
      '  223-259ms against numbers four to five times that here. Rank with them; never quote them.',
  );
}

async function benchLlm(env: Env): Promise<void> {
  console.log(`LLM — time to FIRST TOKEN on the real system prompt (${RUNS} runs each, median)\n`);
  console.log(`  caller says: "${HEBREW_TURN}"\n`);

  const results: Array<{ name: string; ttft: number | null; reply: string; err?: string }> = [];

  for (const c of LLM_CANDIDATES) {
    const samples: number[] = [];
    let reply = '';
    let err: string | undefined;

    for (let i = 0; i < RUNS; i++) {
      try {
        const model = c.build(env);
        const chatCtx = llmBase.ChatContext.empty();
        chatCtx.addMessage({ role: 'system', content: SYSTEM_PROMPT_HE });
        chatCtx.addMessage({ role: 'user', content: HEBREW_TURN });

        const started = Date.now();
        const stream = model.chat({ chatCtx });
        let ttft: number | null = null;
        let text = '';
        for await (const chunk of stream) {
          const delta = chunk.delta?.content ?? '';
          if (delta) {
            ttft ??= Date.now() - started;
            text += delta;
          }
        }
        await stream.close?.();
        if (ttft !== null) samples.push(ttft);
        if (i === 0) reply = text;
      } catch (e) {
        err = e instanceof Error ? e.message.slice(0, 70) : String(e);
        break;
      }
    }

    const ttft = median(samples);
    results.push({ name: c.name, ttft, reply, err });
    console.log(`  ${c.name.padEnd(42)} ${err ? `FAILED — ${err}` : `${String(ttft).padStart(4)}ms`}`);
  }

  const baseline = results.find((r) => r.name.includes('LIVE'))?.ttft;
  console.log('\n  --- ranked ---');
  for (const r of results.filter((r) => !r.err && r.ttft !== null).sort((a, b) => a.ttft! - b.ttft!)) {
    const delta = baseline ? r.ttft! - baseline : 0;
    const tag = !baseline || delta === 0 ? '' : delta < 0 ? `  ${delta}ms FASTER` : `  +${delta}ms slower`;
    console.log(`  ${String(r.ttft).padStart(4)}ms  ${r.name}${tag}`);
  }

  console.log('\n  --- WHAT EACH ONE ACTUALLY SAID (speed is worthless if the Hebrew is bad) ---');
  for (const r of results.filter((r) => r.reply)) {
    console.log(`\n  ${r.name}:\n    ${r.reply.replace(/\n/g, ' ').slice(0, 200)}`);
  }
  console.log('\n  Check: correct feminine self-reference, no invented prices, max 2 sentences.');
}

/**
 * `npm run bench:path` — WHERE THE REPLY IS HELD BEFORE SHE STARTS SPEAKING.
 *
 * The question the phone calls could not answer. Dead air is
 * `end-of-turn + <something> + TTS first byte`, and `<something>` behaved like two different
 * numbers on one call (2026-08-16): a SHORT reply started speaking 218ms after the LLM's first
 * token, a LONG one took 1416ms. Either our sentence buffering holds the opener, or the delay is
 * downstream of us — and two deploys were already spent guessing between those.
 *
 * This runs the LIVE model on the real prompt and pipes its output through the REAL `guardStream`,
 * the same function the agent uses. Three numbers come out:
 *
 *   ttft            first token from the model
 *   firstSentence   first text the guard hands to the TTS   <- the one that matters
 *   fullReply       generation complete
 *
 * If `firstSentence` tracks `ttft`, the guard is innocent and the buffering is in the SDK or
 * Cartesia. If it tracks `fullReply`, the guard is the cost and the fix is ours. No phone call,
 * no waiting for Koren, and it costs cents.
 */
async function benchPath(env: Env): Promise<void> {
  console.log(`SPEECH PATH — when does the first sentence actually reach the TTS? (${RUNS} runs)\n`);
  console.log(`  caller says: "${HEBREW_TURN}"\n`);

  const rows: Array<{ ttft: number; firstSentence: number; full: number; opener: string }> = [];

  for (let i = 0; i < RUNS; i++) {
    const model = new openai.LLM({
      model: env.VOICE_LLM_MODEL ?? env.AI_MODEL,
      ...(env.VOICE_LLM_REASONING_EFFORT ? { reasoningEffort: env.VOICE_LLM_REASONING_EFFORT } : {}),
      ...(env.VOICE_LLM_SERVICE_TIER ? { serviceTier: env.VOICE_LLM_SERVICE_TIER } : {}),
    });
    const chatCtx = llmBase.ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: SYSTEM_PROMPT_HE });
    chatCtx.addMessage({ role: 'user', content: HEBREW_TURN });

    const started = Date.now();
    let ttft = -1;
    let full = -1;

    // The model's token stream, shaped exactly as the agent's ttsNode receives it.
    const tokens = async function* (): AsyncIterable<string> {
      const stream = model.chat({ chatCtx });
      for await (const chunk of stream) {
        const delta = chunk.delta?.content ?? '';
        if (!delta) continue;
        if (ttft < 0) ttft = Date.now() - started;
        yield delta;
      }
      full = Date.now() - started;
      await stream.close?.();
    };

    let firstSentence = -1;
    let opener = '';
    for await (const out of guardStream(tokens())) {
      if (firstSentence < 0) {
        firstSentence = Date.now() - started;
        opener = out.trim();
      }
    }
    rows.push({ ttft, firstSentence, full, opener });
    console.log(
      `  run ${i + 1}   ttft ${String(ttft).padStart(4)}ms   firstSentence ${String(firstSentence).padStart(4)}ms   fullReply ${String(full).padStart(4)}ms   "${opener.slice(0, 40)}"`,
    );
  }

  const ttft = median(rows.map((r) => r.ttft)) ?? 0;
  const first = median(rows.map((r) => r.firstSentence)) ?? 0;
  const full = median(rows.map((r) => r.full)) ?? 0;

  console.log(`\n  medians:  ttft ${ttft}ms   firstSentence ${first}ms   fullReply ${full}ms`);
  console.log(`  the guard held the opener for ${first - ttft}ms after the first token`);

  // The verdict, stated rather than left to interpretation — this bench exists because the same
  // ambiguity was misread twice already.
  const towardFull = Math.abs(first - full) < Math.abs(first - ttft);
  console.log(
    towardFull
      ? '\n  VERDICT: the guard waits for (nearly) the WHOLE reply. The buffering is OURS — fix it here.'
      : '\n  VERDICT: the guard releases the opener promptly. The delay on a real call is DOWNSTREAM of us.',
  );
  console.log(
    `\n  For reference, dead air on a call is end-of-turn (~400ms) + this + TTS first byte (~217ms).\n  Budget for <1s leaves ~380ms for the middle term.`,
  );
}

/**
 * `npm run bench:tier` — is `VOICE_LLM_SERVICE_TIER=priority` actually buying anything?
 *
 * It is set on the live agent and it roughly DOUBLES the token price, justified in agent.config.ts
 * as "faster time-to-first-token". That claim has never been measured against the alternative on
 * this prompt. The suspicion came from two of our own benches disagreeing: `bench:llm` measured
 * 808ms with no tier set, `bench:path` measured 974ms with priority on.
 *
 * RUNS ARE INTERLEAVED, not grouped. OpenAI's latency drifts over minutes, so measuring six of one
 * and then six of the other measures the drift as much as the setting — which is exactly how an
 * earlier endpointing A/B here produced a confident result from two identical arms.
 */
async function benchTier(env: Env): Promise<void> {
  const model = env.VOICE_LLM_MODEL ?? env.AI_MODEL;
  const PAIRS = 6;
  console.log(`SERVICE TIER — is 'priority' worth ~2x the token price? (${model}, ${PAIRS} interleaved pairs)\n`);

  const samples: Record<string, number[]> = { priority: [], default: [] };

  const once = async (tier: 'priority' | 'default'): Promise<number | null> => {
    const llm = new openai.LLM({
      model,
      ...(env.VOICE_LLM_REASONING_EFFORT ? { reasoningEffort: env.VOICE_LLM_REASONING_EFFORT } : {}),
      ...(tier === 'priority' ? { serviceTier: 'priority' as const } : {}),
    });
    const chatCtx = llmBase.ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: SYSTEM_PROMPT_HE });
    chatCtx.addMessage({ role: 'user', content: HEBREW_TURN });

    const started = Date.now();
    try {
      const stream = llm.chat({ chatCtx });
      for await (const chunk of stream) {
        if (chunk.delta?.content) {
          const ttft = Date.now() - started;
          await stream.close?.();
          return ttft;
        }
      }
      await stream.close?.();
    } catch (e) {
      console.log(`    ${tier} FAILED — ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
    }
    return null;
  };

  for (let i = 0; i < PAIRS; i++) {
    // Order flipped each pair so neither arm systematically gets the warmer cache.
    const order: Array<'priority' | 'default'> = i % 2 === 0 ? ['priority', 'default'] : ['default', 'priority'];
    const row: Record<string, number | null> = {};
    for (const tier of order) {
      const ms = await once(tier);
      if (ms !== null) samples[tier]!.push(ms);
      row[tier] = ms;
    }
    console.log(`  pair ${i + 1}   priority ${String(row.priority ?? '—').padStart(4)}ms   default ${String(row.default ?? '—').padStart(4)}ms`);
  }

  const p = median(samples.priority!);
  const d = median(samples.default!);
  console.log(`\n  medians:  priority ${p}ms   default ${d}ms`);
  if (p !== null && d !== null) {
    const delta = d - p;
    console.log(
      Math.abs(delta) < 75
        ? `\n  VERDICT: ${Math.abs(delta)}ms apart — INSIDE THE NOISE. 'priority' is not buying\n  measurable latency here, and it is charging ~2x per token for it. Koren's call.`
        : delta > 0
          ? `\n  VERDICT: priority is ${delta}ms faster. Worth the ~2x token price on voice turns.`
          : `\n  VERDICT: priority is ${-delta}ms SLOWER. It is costing money and time both.`,
    );
  }
  console.log('\n  Note: ~50-token voice replies, so ~2x on output tokens is pennies per call either way.');
  console.log('  Judge it on latency, not on the bill.');
}

/**
 * `npm run bench:ttft` — WHAT THE MODEL'S FIRST TOKEN ACTUALLY DEPENDS ON.
 *
 * THE QUESTION, and why it is now the only one that matters. Dead air on a turn where she waits
 * for GPT decomposes exactly (latency-anatomy.ts, four production calls):
 *
 *     dead air 1479ms  =  model first token 1090  +  tts first byte 224  +  ~165 pipeline
 *
 * Preemptive TTS removes the middle term. The pipeline term is already thin. So every remaining
 * millisecond between here and a one-second turn is in the FIRST TOKEN — and we send ~17,000
 * prompt tokens to get it, 94% of them served from OpenAI's cache.
 *
 * Nobody has measured whether that size costs anything. Two very different worlds hide behind the
 * same 1090ms:
 *
 *   - if the cost is the UNCACHED TAIL (~1k tokens: the coach note, the last turns), it can be
 *     trimmed without changing a single instruction — pure engineering, and Koren need not approve
 *     a word of it;
 *   - if the cost is TOTAL SIZE, the lever is the prompt itself, which IS the agent's behaviour,
 *     and every cut is his call line by line.
 *
 * WHY NOT `bench:llm`. That one sends the system prompt plus ONE message. A real turn carries
 * thirty items of history and a note glued to the tail, and the difference is not academic: the
 * two-message shape is exactly what made `gpt-5.4-mini` look faster than gpt-5.4 in a benchmark
 * before it proved slower on a real call and broke Hebrew gender (known-issues §3). A bench whose
 * shape is wrong does not measure a smaller version of the truth; it measures something else.
 *
 * METHOD — the three ways this measurement could lie, and what stops each:
 *
 *  1. OpenAI's latency drifts over minutes, so arms are INTERLEAVED and rotated, never grouped.
 *     Grouping is how an earlier endpointing A/B in this repo produced a confident result from two
 *     identical arms.
 *  2. The cache is a PREFIX cache, so every arm that changes the prompt starts cold. Each arm is
 *     warmed once, unmeasured, before any run counts — otherwise "smaller prompt" and "cold cache"
 *     are measured as one thing, and the smaller prompt loses on someone else's cost.
 *  3. A cache hit is never assumed: each run reads `promptTokens` and `promptCachedTokens` back off
 *     the stream's own usage and the table prints them, so an arm whose cache did not warm is
 *     visible instead of silently averaged in.
 *
 * Costs ~30 requests of mostly-cached input and stops at the first token, so completion tokens are
 * ~1 each. Cents, not dollars.
 */
async function benchTtft(env: Env): Promise<void> {
  // `--model=` so a model can be judged on the shape it will actually run in. THE POINT of this
  // bench: `bench:llm` compares models on a system prompt plus one message, and that shape is what
  // made gpt-5.4-mini look faster than gpt-5.4 before it lost on a real call (known-issues §3).
  const modelFlag = process.argv.find((a) => a.startsWith('--model='))?.slice('--model='.length);
  const model = modelFlag ?? env.VOICE_LLM_MODEL ?? env.AI_MODEL;
  console.log(`FIRST TOKEN — what does it actually depend on? (${model}, ${RUNS} interleaved runs/arm)\n`);

  /** Caller turns and replies at the length they really are, repeated to build history. */
  const HISTORY_PAIR: Array<[string, string]> = [
    ['היי, אה... ראיתי את המודעה שלכם ולא בדיוק הבנתי מה אתם עושים.', 'בסדר. אנחנו בונים סוכנת קולית שעונה לפניות ומתאמת פגישות. במה אתה עוסק?'],
    ['יש לי עסק קטן, אנחנו מוכרים ריהוט לבית — גם אונליין וגם חנות אחת.', 'הבנתי אותך. מי עונה לפניות אצלכם היום?'],
    ['המזכירה עונה עד ארבע, אחרי זה זה נופל.', 'אוקי. וכמה פניות ביום בערך מגיעות?'],
    ['שבע-שמונה ביום, לפעמים יותר בסופי שבוע.', 'אמ. ומה קורה לפניות שמגיעות בערב?'],
    ['הן פשוט מחכות לבוקר, וחלק מהן כבר קנו במקום אחר.', 'טוב, הבנתי. זה בדיוק מה שאנחנו פותרים.'],
  ];

  /** The coach note as production writes it: ONE system item at the tail, never cached. */
  const coachNote = (bytes: number): string => {
    const unit = 'אל תחזרי על הניסוח הזה. הלקוח כבר אמר לך את השם שלו. שאלת כבר על התהליך. ';
    return bytes === 0 ? '' : unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  };

  const build = (opts: { systemFrac: number; historyPairs: number; tailBytes: number; cold?: boolean }) => {
    const ctx = llmBase.ChatContext.empty();
    // TRUNCATION IS FOR SIZE ONLY. Cutting the prompt mid-sentence would make a terrible prompt; it
    // is a perfectly good way to ask "does length cost time". Nothing here is a proposed prompt.
    const sys = SYSTEM_PROMPT_HE.slice(0, Math.floor(SYSTEM_PROMPT_HE.length * opts.systemFrac));
    // A unique prefix makes the cache miss by construction — that is what the cold arm measures.
    ctx.addMessage({ role: 'system', content: opts.cold ? `${Date.now()}-${Math.random()}\n${sys}` : sys });
    for (let i = 0; i < opts.historyPairs; i++) {
      const [user, assistant] = HISTORY_PAIR[i % HISTORY_PAIR.length]!;
      ctx.addMessage({ role: 'user', content: user });
      ctx.addMessage({ role: 'assistant', content: assistant });
    }
    if (opts.tailBytes > 0) ctx.addMessage({ role: 'system', content: coachNote(opts.tailBytes) });
    ctx.addMessage({ role: 'user', content: HEBREW_TURN });
    return ctx;
  };

  // 15 pairs = 30 history items, the shape a real call carries by mid-conversation. Tail sizes are
  // the MEASURED coach note on production calls: median 1.2-1.8KB, largest seen 4756B.
  const arms: Array<{ key: string; label: string; make: () => llmBase.ChatContext }> = [
    { key: 'prod', label: 'production shape (30 history + 1.5KB note)', make: () => build({ systemFrac: 1, historyPairs: 15, tailBytes: 1500 }) },
    { key: 'no-tail', label: 'same, with NO coach note', make: () => build({ systemFrac: 1, historyPairs: 15, tailBytes: 0 }) },
    { key: 'tail-4.7k', label: 'same, with the LARGEST note seen (4.7KB)', make: () => build({ systemFrac: 1, historyPairs: 15, tailBytes: 4756 }) },
    { key: 'no-history', label: 'full prompt + note, NO history', make: () => build({ systemFrac: 1, historyPairs: 0, tailBytes: 1500 }) },
    { key: 'sys-60', label: 'system prompt cut to 60%', make: () => build({ systemFrac: 0.6, historyPairs: 15, tailBytes: 1500 }) },
    { key: 'sys-30', label: 'system prompt cut to 30%', make: () => build({ systemFrac: 0.3, historyPairs: 15, tailBytes: 1500 }) },
    { key: 'cold', label: 'production shape, CACHE COLD', make: () => build({ systemFrac: 1, historyPairs: 15, tailBytes: 1500, cold: true }) },
  ];

  /**
   * THE ARM THE FIRST RUN WAS MISSING, and it is the one that matters.
   *
   * Every arm above sends NO TOOLS and a prompt built with `toolsEnabled: false` — because
   * `SYSTEM_PROMPT_HE` is. A production turn ships seven tool definitions with their JSON schemas
   * AND the prompt's tool section, and the model must decide whether to call one before it writes
   * a word. The first run measured 802ms here against 992-1090ms on real calls; a 200-300ms gap
   * between a bench and production is exactly the shape of a missing input, not of network jitter.
   *
   * The runtime is a cast stub on purpose: a tool's SCHEMA is fixed at definition, and only its
   * `execute` closure touches `rt`. Nothing here is executed.
   */
  const toolsPrompt = buildSystemPrompt({ toolsEnabled: true });
  const agentTools = buildAgentTools({} as never);
  const buildWithTools = () => {
    const ctx = llmBase.ChatContext.empty();
    ctx.addMessage({ role: 'system', content: toolsPrompt });
    for (let i = 0; i < 15; i++) {
      const [user, assistant] = HISTORY_PAIR[i % HISTORY_PAIR.length]!;
      ctx.addMessage({ role: 'user', content: user });
      ctx.addMessage({ role: 'assistant', content: assistant });
    }
    ctx.addMessage({ role: 'system', content: coachNote(1500) });
    ctx.addMessage({ role: 'user', content: HEBREW_TURN });
    return ctx;
  };
  arms.push({ key: 'tools', label: 'PRODUCTION: 7 tools attached + tool prompt', make: buildWithTools });

  const samples: Record<string, number[]> = Object.fromEntries(arms.map((a) => [a.key, []]));
  const usage: Record<string, { prompt: number; cached: number }> = {};
  let lastUsage: { prompt: number; cached: number } | null = null;

  const once = async (make: () => llmBase.ChatContext, withTools = false): Promise<number | null> => {
    const client = new openai.LLM({
      model,
      ...(env.VOICE_LLM_REASONING_EFFORT ? { reasoningEffort: env.VOICE_LLM_REASONING_EFFORT } : {}),
      ...(env.VOICE_LLM_SERVICE_TIER ? { serviceTier: env.VOICE_LLM_SERVICE_TIER } : {}),
    });
    const started = Date.now();
    let ttft: number | null = null;
    try {
      const stream = client.chat({
        chatCtx: make(),
        ...(withTools ? { toolCtx: llmBase.toToolContext(agentTools) } : {}),
      });
      for await (const chunk of stream) {
        if (chunk.usage) lastUsage = { prompt: chunk.usage.promptTokens, cached: chunk.usage.promptCachedTokens };
        // Usage arrives in the FINAL chunk, so the loop cannot stop at the first token if the token
        // counts are to be read at all. It keeps draining; only `ttft` is the measurement.
        if (ttft === null && chunk.delta?.content) ttft = Date.now() - started;
      }
      await stream.close?.();
    } catch (e) {
      console.log(`    FAILED — ${e instanceof Error ? e.message.slice(0, 70) : String(e)}`);
    }
    return ttft;
  };

  console.log('  warming each arm once (a prefix cache makes every changed prompt start cold)...');
  for (const a of arms) {
    // The cold arm is warmed too: its prefix is unique per call so warming changes nothing for it,
    // and skipping it would leave it with a different number of preceding requests than the rest.
    lastUsage = null;
    await once(a.make, a.key === 'tools');
    if (lastUsage) usage[a.key] = lastUsage;
  }

  for (let i = 0; i < RUNS; i++) {
    // Rotated each round, so no arm systematically owns the same position in the minute.
    const order = [...arms.slice(i % arms.length), ...arms.slice(0, i % arms.length)];
    const row: string[] = [];
    for (const a of order) {
      lastUsage = null;
      const ms = await once(a.make, a.key === 'tools');
      if (ms !== null) samples[a.key]!.push(ms);
      if (lastUsage) usage[a.key] = lastUsage;
      row.push(`${a.key} ${ms ?? '—'}ms`);
    }
    console.log(`  run ${i + 1}   ${row.join('   ')}`);
  }

  const base = median(samples.prod!);
  console.log('\n  arm                                          ttft     vs prod    prompt tokens (cached)');
  for (const a of arms) {
    const ms = median(samples[a.key]!);
    const u = usage[a.key];
    const delta = ms === null || base === null ? '' : ms === base ? '—' : `${ms - base > 0 ? '+' : ''}${ms - base}ms`;
    const tok = u ? `${u.prompt} (${Math.round((u.cached / Math.max(1, u.prompt)) * 100)}%)` : '?';
    console.log(`  ${a.label.padEnd(44)} ${String(ms ?? '—').padStart(5)}ms  ${delta.padStart(8)}    ${tok}`);
  }

  // THE VERDICT IS AN INTERVAL, NOT A THRESHOLD — and the first version of it was wrong.
  //
  // That version compared each arm's median against the baseline and called any gap under a
  // hardcoded 75ms "inside noise". At the default three runs per arm that was not a measurement,
  // it was a coin flip dressed as a finding, and it was reported to Koren as "prompt length is not
  // the cost" — full stop, in those words. He pushed back that shortening the prompt is the one
  // optimisation every guide recommends, and he was right to: at n=3, with a within-arm spread of
  // ~250ms, this instrument could not have seen an effect smaller than about 300ms.
  //
  // A bootstrap interval over the difference of medians says only what the data supports. Where
  // the interval spans zero the arm is UNPROVEN at this sample size — which is not the same as
  // zero — and the interval's own far end states how large an effect could still be hiding. At
  // --runs=12 that turned two "noise" rows into real ones: the cache (+35ms) and the tool
  // definitions (+89ms), the second being the largest prompt-side cost we have and the one no
  // guide mentions.
  console.log('\n  --- what this says (95% bootstrap interval on the difference of medians) ---\n');
  if (base === null) {
    console.log('  The baseline arm produced no token. Nothing above is safe to read.');
    return;
  }
  console.log('  arm                                          difference vs the production shape');
  for (const a of arms) {
    if (a.key === 'prod') continue;
    const v = samples[a.key]!;
    if (v.length < 3) continue;
    const [lo, hi] = bootstrapMedianDiff(v, samples.prod!);
    const d = (median(v) ?? 0) - base;
    const proven = lo > 0 || hi < 0;
    const sign = (n: number): string => `${n > 0 ? '+' : ''}${n}`;
    console.log(
      `  ${a.label.padEnd(44)} ${`${sign(d)}ms`.padStart(7)}  [${sign(lo)}, ${sign(hi)}]  ` +
        `${proven ? 'REAL' : 'unproven at this n'}`,
    );
  }
  console.log(
    '\n  An interval that spans zero has NOT shown an effect, and its far end is the most that could\n' +
      '  still be hiding. Raise --runs= to narrow it before believing either direction.',
  );
  console.log(
    `\n  For the budget: a turn that waits for the model lands at about ttft + tts first byte + 180ms.\n` +
      `  At ${base}ms, with preemptive TTS hiding the voice, that is ~${base + 180}ms of silence.`,
  );
}

/**
 * 95% bootstrap interval on `median(a) - median(b)`.
 *
 * Resampling rather than a t-test because these are medians of a skewed, heavy-tailed distribution
 * — one queued request put a 1269ms sample next to a 705ms one in the same arm — and a test that
 * assumed normality would report a precision the data does not have. Seeded, so two readings of one
 * run agree with each other.
 */
function bootstrapMedianDiff(a: number[], b: number[], iterations = 4000): [number, number] {
  let seed = 7;
  const rand = (): number => {
    // Mulberry32 — deterministic, and short enough to read.
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const drawMedian = (v: number[]): number =>
    median(Array.from({ length: v.length }, () => v[Math.floor(rand() * v.length)]!)) ?? 0;
  const diffs = Array.from({ length: iterations }, () => drawMedian(a) - drawMedian(b)).sort(
    (x, y) => x - y,
  );
  return [
    Math.round(diffs[Math.floor(0.025 * iterations)]!),
    Math.round(diffs[Math.floor(0.975 * iterations)]!),
  ];
}

function median(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!);
}

async function main(): Promise<void> {
  const env = loadEnv();
  initializeLogger({ pretty: false, level: 'error' });

  const what = process.argv[2] ?? 'all';
  try {
    if (what === 'tts' || what === 'all') await benchTts(env);
    if (what === 'all') console.log(`\n${'='.repeat(90)}\n`);
    if (what === 'llm' || what === 'all') await benchLlm(env);
    if (what === 'path') await benchPath(env);
    if (what === 'tier') await benchTier(env);
    if (what === 'ttft') await benchTtft(env);
  } finally {
    // Every engine this run leased, released. DeepDub holds a two-socket pool per instance and
    // nothing else will close it — an unclosed pool keeps the event loop alive and the bench ends
    // by hanging after it has already printed its answer.
    for (const close of closers) await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
