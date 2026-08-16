import { inference, tokenize, tts as ttsBase, type stt as sttBase, type voice } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import type * as silero from '@livekit/agents-plugin-silero';
import { cartesiaOptions } from './testing/speech.js';
import { createSonioxSTT, withPreflightSurvival } from './stt/soniox.stt.js';
import { DeepdubTTS, deepdubOptions } from './tts/deepdub.tts.js';
import type { Env } from '../../../config/env.js';

/**
 * Builds the cascade pipeline: STT -> LLM -> TTS.
 *
 * Split out of `agent.ts` because that file calls `cli.runApp()` at import time — importing it
 * from a test would boot a LiveKit worker. This module is safe to import.
 *
 * Every stage streams; nothing here may buffer a full response between stages
 * (`docs/voice-agent-development-methodology.md`, principle #3).
 */
/**
 * Builds the STT engine named by STT_PROVIDER.
 *
 * Split out so the A/B harness (`npm run stt:ab`) instantiates the SAME engine the live agent does.
 * The alternative — the harness building its own — is how you end up shipping a config that was
 * never the one you measured. We have already been bitten by exactly that: an endpointing A/B whose
 * two arms turned out to be running identical settings, and whose "improvement" was noise.
 */
export function buildSTT(env: Env, vad: silero.VAD): sttBase.STT {
  if (env.STT_PROVIDER === 'soniox') {
    const stt = createSonioxSTT(env);
    // Under 'stt' turn detection LiveKit's preemptive generation never fires: its FINAL path is
    // gated on vadBaseTurnDetection, and the PREFLIGHT path needs an event Soniox effectively
    // never emits. withPreflightSurvival injects a PREFLIGHT once the caller has stopped adding
    // words for VOICE_PREEMPTIVE_PAUSE_MS, so the LLM drafts during the endpoint wait instead of
    // after it. 'vad' already gets preemptive via the FINAL path, so it is left alone.
    return resolveTurnDetection(env) === 'stt'
      ? withPreflightSurvival(stt, env.VOICE_PREEMPTIVE_PAUSE_MS)
      : stt;
  }
  return buildOpenAISTT(env, vad);
}

/**
 * How the turn ends.
 *
 * 'stt' means the STT tells us the caller stopped talking (Soniox's semantic `<end>` token).
 * 'vad' means we wait out a silence timer (Silero) — which for Hebrew costs ~1113ms, because no
 * vendor ships a Hebrew end-of-turn model (docs/phase-4-known-issues.md §4, §5).
 *
 * THE GUARD MATTERS. `gpt-realtime-whisper` never emits END_OF_SPEECH — it is a transcription-only
 * model, which is the same root cause that makes it ignore `semantic_vad`. Setting
 * VOICE_TURN_DETECTION=stt against the OpenAI STT would leave the agent waiting forever for a turn
 * signal that is never coming: the caller talks, and the agent simply never replies. That is a
 * silent, total failure of the product, produced by one plausible-looking env var. So it is refused
 * here rather than documented as a footnote someone reads afterwards.
 */
export function resolveTurnDetection(env: Env): 'vad' | 'stt' {
  if (env.VOICE_TURN_DETECTION === 'stt' && env.STT_PROVIDER !== 'soniox') {
    throw new Error(
      'VOICE_TURN_DETECTION=stt requires STT_PROVIDER=soniox — gpt-realtime-whisper never emits ' +
        'END_OF_SPEECH, so the agent would wait forever and never answer the caller.',
    );
  }
  return env.VOICE_TURN_DETECTION;
}

export function buildSessionComponents(env: Env, vad: silero.VAD): voice.AgentSessionOptions {
  const turnDetection = resolveTurnDetection(env);
  return {
    vad,
    stt: buildSTT(env, vad),
    // The voice LLM. gpt-5.4. WE TRIED gpt-5.4-mini AND IT LOST ON BOTH AXES — read this before
    // trying it again.
    //
    // The bench said mini was a clear win. On the REAL call it was slower AND worse:
    //
    //                          bench (2-msg ctx)    LIVE CALL (real history)   Hebrew gender
    //   gpt-5.4  effort=none        761ms                  848ms               correct
    //   gpt-5.4-mini (unset)        642ms                  966ms  <- SLOWER    BROKEN
    //
    // TWO LESSONS, both expensive:
    //
    // 1. THE BENCH LIED because its context was not the production context. It sent a system prompt
    //    plus one user turn. A live call carries up to VOICE_MAX_HISTORY_ITEMS of conversation, and
    //    mini's time-to-first-token degrades with input far more steeply than gpt-5.4's does. A
    //    latency bench whose context does not match production measures a call that never happens.
    //
    // 2. mini BROKE THE HEBREW GENDER RULES — the caller noticed within one call. Hebrew inflects
    //    by gender across three different persons (herself feminine, the company masculine plural,
    //    the caller by HIS gender; see the system prompt and known-issues §8). gpt-5.4 holds all
    //    three. mini does not. A cheaper model that mangles the grammar is not an optimisation; it
    //    is a worse product that also happened to be slower.
    //
    // Speed is never worth sounding wrong. Do not swap this model without checking BOTH: ttft on a
    // real call with real history, and the gender rules.
    llm: new openai.LLM({
      model: env.VOICE_LLM_MODEL ?? env.AI_MODEL,
      ...(env.VOICE_LLM_REASONING_EFFORT ? { reasoningEffort: env.VOICE_LLM_REASONING_EFFORT } : {}),
      // 'priority' buys faster time-to-first-token — the single largest VISIBLE block in the
      // pipeline (preemptive generation can only hide ~200-600ms of it inside the endpointing
      // window). ~2x token cost is pennies on 50-token voice turns.
      ...(env.VOICE_LLM_SERVICE_TIER ? { serviceTier: env.VOICE_LLM_SERVICE_TIER } : {}),
    }),
    tts: buildTTS(env),
    turnHandling: {
      // 'vad' = wait out a silence timer. For Hebrew that costs ~1113ms, because NO off-the-shelf
      // end-of-turn model supports it (docs/phase-4-known-issues.md §4 — LiveKit's has Arabic and
      // not Hebrew; OpenAI's semantic_vad is silently ignored by gpt-realtime-whisper).
      //
      // 'stt' = Soniox's server tells us the turn ended, semantically, in any language. That is the
      // first credible answer to the ~1113ms wall we wrote off as unfixable. Floor is 500ms
      // (SONIOX_MAX_ENDPOINT_DELAY_MS cannot go lower), so even at its worst it should halve it.
      // Guarded above: 'stt' against the OpenAI STT would hang the agent forever.
      turnDetection,
      endpointing: {
        minDelay: env.VOICE_ENDPOINTING_MIN_DELAY_MS,
        maxDelay: env.VOICE_ENDPOINTING_MAX_DELAY_MS,
      },
      preemptiveGeneration: {
        // Drafts the reply DURING the end-of-turn wait, so the LLM's ~860ms hides behind it instead
        // of stacking on top.
        //
        // This was DEAD for weeks while reading as enabled. `onUserTurnCompleted` used to truncate
        // the chat context, and LiveKit invalidates a draft whose context changed underneath it
        // (agent_activity.ts: `preemptive.chatCtx.isEquivalent(chatCtx)`), so every single draft was
        // discarded and regenerated — 15 times in one call. Trimming now happens between turns
        // instead (agent.ts `trimHistory`), and invalidations dropped 15 -> 1.
        enabled: true,
        // Same idea for TTS: start synthesising the draft before the turn is confirmed, so
        // Cartesia's ~466ms hides behind the endpointing wait rather than landing on top of it.
        // That 466ms is now the single largest block of dead air the caller still hears.
        //
        // IT WAS SWITCHED OFF FOR A BAD REASON. Phase 2 measured it as WORSE (TTS ttfb 390->550ms)
        // — but that was measured while preemptive generation was broken, so every preemptive TTS
        // was synthesising a draft that was then thrown away: pure wasted load, which is exactly
        // what a slowdown looks like. The measurement described a bug, not the feature. Now that
        // drafts survive, it is worth a real test.
        //
        // Cost: Cartesia characters on discarded drafts (a caller who resumes mid-pause). At
        // ~$0.02/min of TTS that is noise next to half a second of the caller's time.
        preemptiveTts: env.VOICE_PREEMPTIVE_TTS,
      },
    },
  };
}

/**
 * The voice. CARTESIA sonic-3, and it is not a free choice — it is the ONLY model that speaks
 * Hebrew intelligibly down a phone line.
 *
 * MEASURED, by synthesizing Hebrew, squeezing it through an 8kHz phone band, and transcribing it
 * back with Soniox (`npm run bench:tts`, then the intelligibility check):
 *
 *   cartesia/sonic-3      ~455ms ttfb   intelligible
 *   cartesia/sonic-3.5    ~388ms ttfb   intelligible, no faster in practice
 *   elevenlabs/flash_v2_5 ~274ms ttfb   95% WER — IT DOES NOT SPEAK HEBREW. It returned "DSMH, אין."
 *
 * ElevenLabs Flash is the fastest TTS on the market and it is USELESS to us. A voice that is 180ms
 * quicker and unintelligible on a narrowband line does not make the call faster — it makes the
 * caller say "מה?" and you pay for the entire turn again. This is the third time a "fast" model has
 * turned out not to speak Hebrew (see sonic-turbo, known-issues §2). Never judge a TTS on latency
 * without transcribing it back.
 *
 * The ROUTE is the only thing left to tune: same model and voice either way.
 */
function buildTTS(env: Env): ttsBase.TTS {
  // DeepDub, behind the flag. Won a blind Hebrew A/B (6:1) on quality + native gender at cost parity,
  // realtime model ~125ms. NOT default — this branch only fires on VOICE_TTS_PROVIDER=deepdub, so
  // Cartesia keeps serving until a decision is made. One env var to revert. See tts/deepdub.tts.ts.
  if (env.VOICE_TTS_PROVIDER === 'deepdub') {
    return new DeepdubTTS(deepdubOptions(env));
  }
  // ElevenLabs over the low-latency WEBSOCKET (multi-stream-input). Official plugin, mirrors Cartesia.
  // Fail LOUD if key/voice missing: ElevenLabs returns a SILENT empty stream (not an error) when voiceId
  // is absent. PCM out (pcm_22050) avoids an mp3 decode hop on the phone path; LiveKit resamples to 8kHz.
  //
  // THE WEBSOCKET/MODEL MATRIX (learned the hard way on real calls — see worklog):
  //  - flash_v2_5 / turbo_v2_5 connect on the ws, but flash's Hebrew auto-detect is gibberish and it
  //    REJECTS language_code=he (1008). Good for latency, bad for Hebrew.
  //  - multilingual_v2 / v3 speak good Hebrew and ACCEPT language_code=he, but the plugin 403s their
  //    ws HANDSHAKE — because it appends auto_mode=true & sync_alignment=true, which those models don't
  //    support. So we drive both OFF (ELEVENLABS_AUTO_MODE / _SYNC_ALIGNMENT default false) to let the
  //    quality model connect over the websocket. `language` is passed only when ELEVENLABS_LANGUAGE is
  //    set (empty for flash/turbo to avoid the 1008; 'he' for multilingual_v2). All env-driven so the
  //    model/language/handshake combo is tunable via secrets without a redeploy.
  if (env.VOICE_TTS_PROVIDER === 'elevenlabs') {
    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
      throw new Error(
        'ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required when VOICE_TTS_PROVIDER=elevenlabs',
      );
    }
    const elevenTTS = new elevenlabs.TTS({
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      model: env.ELEVENLABS_MODEL,
      encoding: 'pcm_22050',
      autoMode: env.ELEVENLABS_AUTO_MODE,
      syncAlignment: env.ELEVENLABS_SYNC_ALIGNMENT,
      ...(env.ELEVENLABS_LANGUAGE ? { language: env.ELEVENLABS_LANGUAGE } : {}),
      ...(env.ELEVENLABS_STREAMING_LATENCY !== undefined
        ? { streamingLatency: env.ELEVENLABS_STREAMING_LATENCY }
        : {}),
    });
    if (env.ELEVENLABS_USE_HTTP) {
      // v3 / Voice-Design voices only render over ElevenLabs' HTTP endpoint (the ws multi-stream-input
      // 403s them). StreamAdapter presents a streaming interface to the session but synthesizes each
      // sentence via the wrapped plugin's HTTP synthesize() (POST /text-to-speech/{voice}/stream),
      // tokenizing so first audio still starts after the first sentence rather than the whole reply.
      return new ttsBase.StreamAdapter(elevenTTS, new tokenize.basic.SentenceTokenizer());
    }
    return elevenTTS;
  }
  if (env.VOICE_TTS_ROUTE === 'inference') {
    const opts = cartesiaOptions(env);
    return new inference.TTS({
      model: 'cartesia/sonic-3',
      voice: env.CARTESIA_VOICE_ID_PRIMARY,
      language: env.VOICE_LANGUAGE,
      // 24kHz, EXPLICITLY. This line is the whole reason the first attempt at this route shipped a
      // worse-sounding agent to a real caller.
      //
      // The two routes have DIFFERENT DEFAULTS: the direct Cartesia plugin asks for 24000
      // (agents-plugin-cartesia/src/tts.ts:87), LiveKit's gateway defaults to 16000
      // (agents/src/inference/tts.ts DEFAULT_SAMPLE_RATE). Switching route therefore quietly
      // downgraded the audio, which was then squeezed to 8kHz for the phone — degrading twice.
      // Koren heard it immediately: "the voice was a bit hard to understand".
      //
      // Same model, same voice, same speed — and a silently different sample rate. When you change
      // the ROUTE to a provider, diff every default, not just the options you meant to pass.
      sampleRate: 24_000,
      // The intelligibility levers for the 8kHz line (slower, louder). Tuned in Phase 2 by ear on a
      // real call; they are not cosmetic and must survive any route change.
      modelOptions: { speed: opts.speed, volume: opts.volume },
    });
  }
  // Direct, with our own key. Options come from cartesiaOptions() so the agent and the test
  // harness cannot drift apart.
  return new cartesia.TTS(cartesiaOptions(env));
}

/**
 * OpenAI streaming STT — the fallback. Soniox is the default; see env.ts for why.
 *
 * `gpt-realtime-whisper` streams partial transcripts over a WebSocket as the caller speaks.
 */
function buildOpenAISTT(env: Env, vad: silero.VAD): sttBase.STT {
  return new openai.STT({
    model: env.OPENAI_REALTIME_MODEL,
    language: env.VOICE_LANGUAGE,
    useRealtime: true,
    vad,
    // Bias transcription towards the words we actually expect. Hebrew STT invents plausible
    // nonsense from what it half-hears — on a live call it turned "קורן" into "קורנטיטרי" and
    // "השארתי פרטים" into "הייתי פרטימה". Phase 4 has to capture a NAME, PHONE and EMAIL, so this
    // is not cosmetic: it is the difference between a booking and a wrong booking.
    //
    // BUT: gpt-realtime-whisper REJECTS `prompt` ("The 'prompt' parameter is not supported for this
    // model") and the session dies with an stt_error. Biasing requires whisper-1, which is REST and
    // costs ~1s per turn — hence the Phase 4 "hybrid STT" workaround.
    //
    // MEASURED A/B on the same scripted call ("קוראים לי קורן" / phone / email):
    //   gpt-realtime-whisper  name OK, phone "05 0255 784",  email "המל … קליקס כ-.קום"  eou ~950ms
    //   whisper-1 + biasing   name OK, phone "050-255-784",  email "המייל … קליקסקיילס"  eou ~2000ms
    //
    // THIS IS WHY SONIOX IS BEING EVALUATED: it takes biasing terms (`context.terms`) on a
    // STREAMING connection, i.e. accuracy WITHOUT the second. If the A/B confirms that on Hebrew,
    // the hybrid workaround is deleted rather than built. See stt/soniox.stt.ts.
    ...(env.VOICE_STT_PROMPT && env.OPENAI_REALTIME_MODEL !== 'gpt-realtime-whisper'
      ? { prompt: env.VOICE_STT_PROMPT }
      : {}),
    // NOTE: do NOT pass `turnDetection: { type: 'semantic_vad' }` here. It typechecks, the worker
    // boots clean, and it does NOTHING — gpt-realtime-whisper is a transcription-only model and the
    // plugin logs "Turn detection is not supported for gpt-realtime-whisper; ignoring the provided
    // turnDetection". Same root cause as its never emitting END_OF_SPEECH, which is why
    // VOICE_TURN_DETECTION=stt is refused against this engine.
  });
}
