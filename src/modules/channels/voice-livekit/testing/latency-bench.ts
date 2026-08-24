/**
 * Latency bench — hunt down the ~1.8s worst-case response time.
 *
 *   npm run bench:tts     time-to-first-AUDIO for every Hebrew-capable TTS
 *   npm run bench:llm     time-to-first-TOKEN for every candidate LLM, on our real prompt
 *
 * WHAT WE ARE ACTUALLY OPTIMISING. After the caller stops speaking he waits through three things:
 *
 *   end-of-turn   ~496ms   deciding he finished          (Silero + endpointing)
 *   LLM ttft      ~848ms   GPT thinking                  (mostly hidden by preemptive generation)
 *   TTS ttfb      ~455ms   Cartesia starting to speak    (partly hidden by preemptive TTS)
 *
 * Only the first is unavoidable dead air. The other two are what this bench attacks, and they are
 * the ONLY two we can change by swapping a model.
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
import * as cartesia from '@livekit/agents-plugin-cartesia';
import { DeepdubTTS, deepdubOptions } from '../tts/deepdub.tts.js';
import * as openai from '@livekit/agents-plugin-openai';
import { loadEnv } from '../../../../config/env.js';
import { cartesiaOptions } from './speech.js';
import { SYSTEM_PROMPT_HE } from '../prompts/system-prompt.he.js';
import { toPhoneWav, toStudioWav } from './wav.js';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Env } from '../../../../config/env.js';

/** A real reply, the length she actually speaks. Benchmarking on "hello" measures nothing. */
const HEBREW_LINE =
  'בשמחה, אנחנו עוזרים לעסקים להביא יותר לידים דרך קידום ממומן ואוטומציות. רוצה שאקבע לך שיחה עם קורן?';

/** What a caller actually says, mid-conversation, to make the LLM benchmark honest. */
const HEBREW_TURN = 'תגידי, כמה זה עולה ואיך אתם יכולים לעזור לי עם הלידים שלי?';

const RUNS = 3;
const OUT_DIR = 'voice-samples/bench';

// ---------------------------------------------------------------------------------------------
// TTS candidates. Hebrew is the filter that kills most of them: Deepgram Aura and Rime are
// English-only, so they are not here. A model that cannot speak Hebrew is not a fast model, it is
// a broken one — and we have been burned by exactly that (sonic-turbo returns EMPTY audio for
// Hebrew and only whispers about it at DEBUG level; known-issues §2).
// ---------------------------------------------------------------------------------------------
interface TtsCandidate {
  /** A function when the row's identity depends on env — see the LIVE row's comment for why. */
  name: string | ((env: Env) => string);
  build: (env: Env) => ttsBase.TTS;
  /** Set when the model is known to be dubious on Hebrew — listen to the WAV before believing it. */
  note?: string;
}

/**
 * ElevenLabs voices. A voice ID is REQUIRED — omitting it returns an EMPTY STREAM, not an error,
 * which reads exactly like "this model cannot speak Hebrew" and is nothing of the sort. That is the
 * same failure signature as sonic-turbo (known-issues §2), and it fooled the first run of this
 * bench. These are ElevenLabs' public multilingual voices; all of them speak Hebrew.
 */
const EL_VOICE_FEMALE = 'XB0fDUnXU5powFXDhCwa'; // Charlotte — female, multilingual
const EL_VOICE_ALT = '9BWtsMINqrJLrRacOk9x'; // Aria — female, multilingual

const TTS_CANDIDATES: TtsCandidate[] = [
  {
    // THE BASELINE — our live config, direct to Cartesia with our own key. Every other row is only
    // meaningful relative to this one.
    //
    // NAMED FROM ENV, because it does not run whatever model the label says — it runs CARTESIA_MODEL.
    // It was hardcoded to "sonic-3" while CARTESIA_MODEL had been sonic-3.5 since 2026-08-05, so this
    // row silently reported sonic-3.5's latency under sonic-3's name. Anyone comparing the two rows
    // was comparing the same model to itself, which is a plausible reason the 2026-08-05 latency A/B
    // read as noise.
    name: (env) => `cartesia/${env.CARTESIA_MODEL} (LIVE, direct)`,
    build: (env) => new cartesia.TTS(cartesiaOptions(env)),
  },
  {
    // DEEPDUB — the one candidate never benched, despite winning Koren's blind Hebrew A/B 6:1 on
    // quality and native gender at cost parity, with a realtime model documented at ~125ms.
    //
    // It was missing from this file entirely, which is how "the lever, not yet pulled" stayed unpulled:
    // every latency conversation compared Cartesia against ElevenLabs and never against the thing that
    // had already won on quality. If it is also fast, it is not a trade-off at all.
    name: (env) => `deepdub/${env.DEEPDUB_MODEL}${env.DEEPDUB_REALTIME ? ' (realtime)' : ''}`,
    build: (env) => new DeepdubTTS(deepdubOptions(env)),
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
    name: 'cartesia/sonic-3.5',
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
  // Direct-route twins of the two OpenAI minis. The gateway rows above died on 2026-08-24 with
  // MaxGatewayCredits exhausted — a billing state, not a model property — and the OpenAI key is
  // ours, so these keep the most important comparison alive regardless of LiveKit credit balance.
  {
    name: 'openai/gpt-5.4-mini (direct)',
    build: () => new openai.LLM({ model: 'gpt-5.4-mini', reasoningEffort: 'none' }),
  },
  { name: 'openai/gpt-4.1-mini (direct)', build: () => new openai.LLM({ model: 'gpt-4.1-mini' }) },
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
  console.log(`TTS — time to FIRST AUDIO on a real Hebrew reply (${RUNS} runs each, median)\n`);
  console.log(`  "${HEBREW_LINE}"\n`);

  const results: Array<{ name: string; ttfb: number | null; note?: string; err?: string }> = [];

  for (const c of TTS_CANDIDATES) {
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

        let ttfb: number | null = null;
        const got: AudioFrame[] = [];
        for await (const ev of stream) {
          if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
          ttfb ??= Date.now() - started;
          got.push(ev.frame);
        }
        stream.close();

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
    const label = typeof c.name === 'function' ? c.name(env) : c.name;
    results.push({ name: label, ttfb, note: c.note, err });

    if (frames.length > 0) {
      // Judge the voice on the PHONE band, never on studio audio — an 8kHz line strips the
      // frequencies that carry Hebrew consonants, and a voice that is lovely in a browser can be
      // unintelligible on a call. That is not hypothetical; it is what happened to us.
      const safe = label.replace(/[^a-z0-9.]+/gi, '_');
      await writeFile(`${OUT_DIR}/${safe}-phone.wav`, toPhoneWav(frames));
      await writeFile(`${OUT_DIR}/${safe}-studio.wav`, toStudioWav(frames));
    }

    console.log(
      `  ${label.padEnd(38)} ${err ? `FAILED — ${err}` : `${String(ttfb).padStart(4)}ms`}` +
        `${c.note ? `   (${c.note})` : ''}`,
    );
  }

  const baseline = results.find((r) => r.name.includes('LIVE'))?.ttfb;
  console.log('\n  --- ranked (working models only) ---');
  for (const r of results.filter((r) => !r.err && r.ttfb !== null).sort((a, b) => a.ttfb! - b.ttfb!)) {
    const delta = baseline ? r.ttfb! - baseline : 0;
    const tag = !baseline || delta === 0 ? '' : delta < 0 ? `  ${delta}ms FASTER` : `  +${delta}ms slower`;
    console.log(`  ${String(r.ttfb).padStart(4)}ms  ${r.name}${tag}`);
  }
  console.log(`\n  Samples in ${OUT_DIR}/ — LISTEN TO THE -phone.wav FILES BEFORE CHOOSING.`);
  console.log('  A fast voice that is unintelligible down a phone line is not a win.');
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
        // The LLM is an EventEmitter, and an emitted 'error' with no listener THROWS OUT OF THE
        // EMIT PATH and kills the whole bench — one dead candidate (gateway 429) took every
        // remaining row with it on 2026-08-24. The stream iteration still rejects into the catch
        // below; this listener only stops Node treating the event itself as fatal.
        model.on?.('error', () => {});
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
    console.log(`  ${String(c.name).padEnd(42)} ${err ? `FAILED — ${err}` : `${String(ttft).padStart(4)}ms`}`);
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

function median(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!);
}

async function main(): Promise<void> {
  // A dead candidate must cost ONE row, never the run. The plugins launch background tasks whose
  // rejections escape the per-candidate try/catch entirely (LiveKit's retry wrapper rejects its
  // mainTask asynchronously — on 2026-08-24 a gateway 429 took the whole bench down twice: once as
  // an unlistened 'error' event, once as an unhandled rejection). This is a measurement tool, so a
  // process-level net is the honest fix; each swallowed rejection still surfaces as its row's err.
  process.on('unhandledRejection', (reason) => {
    console.error(`  (background task rejected: ${String(reason).slice(0, 100)})`);
  });
  const env = loadEnv();
  initializeLogger({ pretty: false, level: 'error' });

  const what = process.argv[2] ?? 'all';
  if (what === 'tts' || what === 'all') await benchTts(env);
  if (what === 'all') console.log(`\n${'='.repeat(90)}\n`);
  if (what === 'llm' || what === 'all') await benchLlm(env);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
