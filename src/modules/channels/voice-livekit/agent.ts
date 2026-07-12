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
    proc.userData.vad = await silero.VAD.load();
  },

  // Runs once per call.
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad as silero.VAD;
    const session = new voice.AgentSession(buildSessionComponents(env, vad));

    await session.start({
      agent: new voice.Agent({ instructions: SYSTEM_PROMPT_HE }),
      room: ctx.room,
    });
    console.log('agent_ready', Date.now());

    // Speak the greeting verbatim rather than letting the LLM improvise one: deterministic
    // wording, and no LLM round-trip before the caller hears anything.
    // allowInterruptions:false so a cough or line noise doesn't swallow the greeting.
    await session.say(GREETING, { allowInterruptions: false }).waitForPlayout();

    // Baseline timing only — Phase 2 replaces this with per-stage instrumentation
    // (VAD / STT-first-token / LLM-first-token / TTS-first-audio).
    // Attached AFTER the greeting on purpose: the greeting is a canned say(), not an LLM turn,
    // so listening earlier would timestamp the wrong thing.
    let firstReplyLogged = false;
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (!firstReplyLogged && ev.newState === 'speaking') {
        firstReplyLogged = true;
        console.log('first_reply', Date.now());
      }
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
