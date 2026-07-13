import type { stt as sttBase, voice } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as openai from '@livekit/agents-plugin-openai';
import type * as silero from '@livekit/agents-plugin-silero';
import { cartesiaOptions } from './testing/speech.js';
import { createSonioxSTT } from './stt/soniox.stt.js';
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
    return createSonioxSTT(env);
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
    // Voice gets its own model + reasoning budget. gpt-5.x are reasoning models: measured ~1030ms
    // to first token on an 8-line prompt, which is a THIRD of the caller's perceived wait spent
    // thinking about "hello". VOICE_LLM_MODEL can point at a different model without touching
    // AI_MODEL, which the rest of the app still uses.
    llm: new openai.LLM({
      model: env.VOICE_LLM_MODEL ?? env.AI_MODEL,
      // Only send it if set. gpt-5.4 rejects unknown values with a 400 that kills the call
      // mid-conversation and silences the agent — 'minimal' is NOT valid here (it is
      // none|low|medium|high|xhigh). Unset = don't send the parameter at all.
      ...(env.VOICE_LLM_REASONING_EFFORT ? { reasoningEffort: env.VOICE_LLM_REASONING_EFFORT } : {}),
    }),
    // Options come from cartesiaOptions() so the agent and the test harness cannot drift apart.
    // It also handles the language trap: sonic-turbo REJECTS language:'he' ("Invalid language for
    // model") and returns an empty stream with only a DEBUG log — which looks identical to "this
    // model has no Hebrew", but isn't. Compare models with: npm run voice:ab -- <model>
    tts: new cartesia.TTS(cartesiaOptions(env)),
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
        // Already defaults to true, so the LLM was ALREADY overlapping the endpointing wait — that
        // is why ~800ms of LLM ttft never showed up as ~800ms of extra dead air.
        enabled: true,
        // Defaults to FALSE. In theory it hides Cartesia's ~390ms behind the endpointing wait; in
        // the first measured run it made things WORSE (TTS ttfb 390->550ms). Switchable so it can
        // be re-measured rather than argued about.
        preemptiveTts: env.VOICE_PREEMPTIVE_TTS,
      },
    },
  };
}

/**
 * OpenAI streaming STT — the incumbent, and the baseline the Soniox A/B is measured against.
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
