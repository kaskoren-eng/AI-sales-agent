import { fileURLToPath } from 'node:url';
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { loadEnv } from '../../../config/env.js';
import { buildSessionComponents } from './agent.config.js';
import { SYSTEM_PROMPT_HE } from './prompts/system-prompt.he.js';

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

const GREETING = 'שלום, איך אני יכול לעזור?';

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

    await session.start({
      agent: new voice.Agent({ instructions: SYSTEM_PROMPT_HE }),
      room: ctx.room,
    });

    // Speak the greeting verbatim rather than letting the LLM improvise one: deterministic
    // wording, and no LLM round-trip before the caller hears anything.
    // allowInterruptions:false so a cough or line noise doesn't swallow the greeting.
    await session.say(GREETING, { allowInterruptions: false }).waitForPlayout();
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
