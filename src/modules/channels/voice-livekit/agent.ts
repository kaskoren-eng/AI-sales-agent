import { fileURLToPath } from 'node:url';
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { TelephonyBackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { RoomEvent, type RemoteAudioTrack, TrackKind } from '@livekit/rtc-node';
import { loadEnv } from '../../../config/env.js';
import { buildSessionComponents } from './agent.config.js';
import { GREETING_HE, SYSTEM_PROMPT_HE } from './prompts/system-prompt.he.js';
import { ShadowSTT } from './stt/shadow-stt.js';

/**
 * LiveKit voice agent — Phase 1 skeleton of the Retell -> LiveKit migration.
 *
 * This runs as its OWN process, not inside the Fastify server: `cli.runApp()` below takes over
 * the process (it forks a child per call and owns shutdown). Consequences:
 *   - Nothing may import this file. Shared logic lives in `agent.config.ts`.
 *   - No Fastify imports here — config comes from `loadEnv()` directly. This keeps the agent
 *     deployable standalone to LiveKit Cloud via `lk agent deploy` (Phase 6).
 *
 * Run it: `npm run voice:console` (terminal mic) or `npm run voice:dev` (LiveKit room).
 * See ./README.md.
 */
const env = loadEnv();

// Lives with the prompt, not here: the greeting and the prompt must agree on the agent's gender,
// and v1 had them disagree — a female voice opening with a masculine verb ("יכול", not "יכולה").

/**
 * The agent, with the conversation history trimmed before every LLM call.
 *
 * Without this, the ENTIRE call is re-sent to the LLM on every single turn: a 4-minute call ended
 * at 10,249 input tokens, and it grows QUADRATICALLY with call length.
 *
 * MEASURED, and worth being honest about: this is a COST saving, not a latency one.
 *   untrimmed: 3836 input tokens, LLM ttft 1094ms
 *   16 items:  3055 input tokens, LLM ttft 1092ms
 * gpt-5.4's ~1.1s to first token is fixed overhead, not a function of input size at this scale.
 *
 * `truncate()` mutates in place and always keeps the system prompt, so the agent never loses who
 * she is — only the far end of the conversation. Trade-off: she forgets what was said more than
 * ~8 exchanges ago. For a booking call that is a non-issue; if it ever bites (a caller
 * back-referencing something from five minutes earlier), raise VOICE_MAX_HISTORY_ITEMS.
 */
class ClickScalesAgent extends voice.Agent {
  async onUserTurnCompleted(chatCtx: llm.ChatContext, _newMessage: llm.ChatMessage): Promise<void> {
    chatCtx.truncate(env.VOICE_MAX_HISTORY_ITEMS);
  }
}

export default defineAgent({
  // Runs once when the worker boots, not per call — so the first caller doesn't pay for the
  // VAD model load.
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load({
      // How long Silero waits in silence before calling the turn over.
      minSilenceDuration: env.VOICE_VAD_MIN_SILENCE_MS,
      // THE lever for telephony. Silero decides "still speaking" from audio ENERGY, and a phone
      // line is never digitally silent — hiss and comfort noise sit above the default 0.5
      // threshold, so the silence timer above never gets a chance to fire. Measured on a real
      // call: end-of-turn stayed at ~1030ms despite a 250ms timer, while the synthetic caller
      // (which sends TRUE digital silence) reported 258ms. The harness was measuring a condition
      // that does not exist on a telephone. Raising this makes the VAD ignore the noise floor.
      activationThreshold: env.VOICE_VAD_ACTIVATION_THRESHOLD,
    });
  },

  // Runs once per call.
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad as silero.VAD;
    const session = new voice.AgentSession(buildSessionComponents(env, vad));

    // Connect FIRST. waitForParticipant() throws "room is not connected" otherwise — you cannot
    // ask who is on the call before picking up the phone. (session.start() below also connects,
    // but it does so too late for this.)
    await ctx.connect();

    // Who is calling? For a phone call, LiveKit puts the caller's number on the SIP
    // participant's attributes. For a browser session (the Agent Console, the synthetic
    // caller) these are simply absent — hence `?? null` rather than a throw.
    // PHASE 4 will use callerPhone to look up the lead in the DB and load their history.
    const participant = await ctx.waitForParticipant();
    const caller = readSipCaller(participant.attributes);
    console.log('call_started', JSON.stringify({ room: ctx.room.name, ...caller }));

    // Per-turn latency baseline. LiveKit already measures each stage; we just surface it.
    // Wall-clock timestamps are useless here — the gap between turns is the human thinking,
    // not the pipeline working. These are the numbers the Phase 2 budget is written against:
    //   endOfUtteranceDelayMs — how long we waited before deciding the caller had finished
    //   ttftMs                — LLM time to first token
    //   ttfbMs                — TTS time to first audio byte
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as Record<string, unknown>;
      const stage = String(m.type ?? 'unknown');
      const timings = (['endOfUtteranceDelayMs', 'ttftMs', 'ttfbMs', 'durationMs'] as const)
        .filter((k) => typeof m[k] === 'number')
        .map((k) => `${k}=${Math.round(m[k] as number)}`);
      if (timings.length > 0) {
        ctx.proc.userData.lastMetricsAt = Date.now();
        console.log(`latency ${stage} ${timings.join(' ')}`);
      }
    });

    // Per-call usage, so cost is a measured number and not an estimate. LiveKit tallies LLM
    // tokens, STT audio seconds and TTS characters for us; we just have to listen. Without this
    // the only way to cost a call is to guess at token counts from the transcript.
    // PHASE 4 will persist this alongside the transcript in call_learnings.
    session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, (ev) => {
      console.log('call_usage', JSON.stringify(ev.usage ?? ev));
    });

    // SHADOW MODE — the candidate STT listens to the real caller and says nothing.
    //
    // Everything here is best-effort and cannot fail the call. If the shadow engine won't start,
    // the call runs exactly as if the flag were off. See stt/shadow-stt.ts for the safety contract:
    // separate audio stream, separate engine, every path try/caught, breaker on the candidate.
    //
    // NOTE: this logs what both engines HEARD, but persistence to call_learnings needs a
    // call_learnings row to attach to — which is PHASE 4 work (nothing writes that row today for a
    // LiveKit call). Until then the shadow transcript is logged to stdout, where the analysis script
    // cannot read it. Wire `shadow.persist(db, id)` into the Phase 4 shutdown hook.
    const shadow = env.SHADOW_STT_ENABLED ? new ShadowSTT(env) : null;
    if (shadow) {
      console.log('shadow_stt_enabled', JSON.stringify({ engine: shadow.shadowEngine }));
      ctx.room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === TrackKind.KIND_AUDIO) {
          void shadow.start(track as RemoteAudioTrack);
        }
      });
      // What the LIVE engine heard, so the two can be compared turn by turn.
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        if (ev.isFinal) shadow.recordAuthoritative(ev.transcript);
      });
      ctx.addShutdownCallback(async () => {
        console.log('shadow_stt_result', JSON.stringify(shadow.snapshot()));
      });
    }

    await session.start({
      agent: new ClickScalesAgent({ instructions: SYSTEM_PROMPT_HE }),
      room: ctx.room,
      inputOptions: {
        // Clean the caller's audio BEFORE the VAD sees it. This is the missing piece behind the
        // end-of-turn problem: Silero decides "still speaking" from audio ENERGY, and a phone line
        // is never digitally silent — hiss and comfort noise sit above its threshold, so the
        // silence timer never fires. Measured: end-of-turn 258ms against the synthetic caller
        // (which sends TRUE digital silence) vs ~950ms on a real phone, with identical config.
        //
        // Krisp on the SIP trunk (krispEnabled) was already on and did NOT fix this — that is
        // server-side. This is the agent-side filter, and the *Telephony* variant is tuned for
        // exactly our case: narrowband 8kHz audio with line noise.
        //
        // If this works, the 250/200ms endpointing we already configured finally takes effect and
        // ~700ms comes off every turn. If it doesn't, end-of-turn needs a Hebrew EOT model, which
        // nobody sells.
        noiseCancellation: TelephonyBackgroundVoiceCancellation(),
      },
    });

    // Speak the greeting verbatim rather than letting the LLM improvise one: deterministic
    // wording, and no LLM round-trip before the caller hears anything.
    // allowInterruptions:false so a cough or line noise doesn't swallow the greeting.
    await session.say(GREETING_HE, { allowInterruptions: false }).waitForPlayout();
  },
});

/**
 * Pulls the caller's details off a SIP participant's attributes.
 *
 * LiveKit sets `sip.phoneNumber` (who called), `sip.trunkPhoneNumber` (the number they called —
 * ours), and `sip.callID` on participants that arrive over the phone. A participant that joined
 * from a browser has none of these, so every field is nullable — do not assume a phone call.
 */
function readSipCaller(attributes: Record<string, string>): {
  callerPhone: string | null;
  calledNumber: string | null;
  sipCallId: string | null;
  isPhoneCall: boolean;
} {
  const callerPhone = attributes['sip.phoneNumber'] ?? null;
  return {
    callerPhone,
    calledNumber: attributes['sip.trunkPhoneNumber'] ?? null,
    sipCallId: attributes['sip.callID'] ?? null,
    isPhoneCall: callerPhone !== null,
  };
}

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
