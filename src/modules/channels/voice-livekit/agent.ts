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
import { type AudioFrame, RoomEvent, type RemoteAudioTrack, TrackKind } from '@livekit/rtc-node';
import { loadEnv } from '../../../config/env.js';
import { buildSessionComponents } from './agent.config.js';
import { CallReport } from './call-report.js';
import { GREETING_HE, SYSTEM_PROMPT_HE } from './prompts/system-prompt.he.js';
import {
  FILLER_COOLDOWN_MS,
  MAX_FILLERS_PER_CALL,
  pickThinkingFiller,
} from './prompts/thinking-fillers.he.js';
import { guardSpeech } from './speech-guard.js';
import { ShadowSTT } from './stt/shadow-stt.js';

/** Where every call's report lands. Repo-root relative, gitignored — these contain caller PII. */
const CALL_REPORTS_DIR = 'call-reports';

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
 * The agent.
 *
 * NOTE THE ABSENCE OF `onUserTurnCompleted`. Mutating the chat context in that hook SILENTLY
 * DISABLES PREEMPTIVE GENERATION, which is the biggest latency mechanism in the pipeline.
 *
 * This class used to call `chatCtx.truncate()` there. LiveKit snapshots the context to build its
 * preemptive draft, then checks `preemptive.chatCtx.isEquivalent(chatCtx)` once the hook returns
 * (agent_activity.ts:2394). Truncating inside the hook makes that check fail, so the draft is
 * cancelled and the reply is regenerated from scratch. The log said so on EVERY turn — 15 times in
 * one 4-minute call:
 *
 *   WARN  preemptive generation enabled but chat context or tools have changed after
 *         `onUserTurnCompleted`
 *
 * It was dead from the moment the truncate landed (217ff07) while the config said `enabled: true`.
 *
 * Trimming is done in `trimHistory()` below instead — AFTER the agent has replied, when no draft is
 * in flight. The next turn's draft then snapshots an already-trimmed context and nothing changes
 * underneath it.
 */
class ClickScalesAgent extends voice.Agent {
  /**
   * The last gate before text becomes sound.
   *
   * Two things escaped on Koren's first Keren-v2 call, and neither is fixable by prompting — the
   * model was doing exactly what it was told:
   *
   *   - She spoke `NO_RESPONSE_NEEDED` ALOUD, in English, to a Hebrew caller who had asked her to
   *     hold on. It is a RETELL convention (the platform intercepts it); LiveKit has no such
   *     convention, so it went straight to Cartesia and Cartesia read it out.
   *
   *   - She said "קבעתי לך שיחת דמו למחר" — I HAVE BOOKED YOUR DEMO FOR TOMORROW. No calendar was
   *     touched. This agent has no tools at all. The lead hangs up believing he has a meeting and a
   *     confirmation coming, and nobody ever rings him. That is worse than a crash: it looks like
   *     success to everyone.
   *
   * Buffering the whole reply before synthesis costs us the streamed-TTS overlap. That is a real
   * latency cost and it is worth paying: a regex over a token stream would match half a word and
   * mangle it, and we can afford to be slightly slower far more easily than we can afford to tell a
   * lead his meeting is booked when it is not.
   *
   * Delete this ONLY when Phase 4 wires the calendar tools and the claim becomes true.
   */
  override async ttsNode(
    text: Parameters<voice.Agent['ttsNode']>[0],
    modelSettings: voice.ModelSettings,
  ): ReturnType<voice.Agent['ttsNode']> {
    let full = '';
    for await (const chunk of text as AsyncIterable<string>) full += chunk;

    const guarded = guardSpeech(full);
    for (const note of guarded.interventions) {
      console.log(`speech_guard ${JSON.stringify({ note, said: guarded.text.slice(0, 80) })}`);
    }
    // The whole utterance was a control token: she is MEANT to stay silent. Returning null means
    // no audio at all, which is exactly right when the caller has just said "רגע".
    if (guarded.silent) return null;

    return voice.Agent.default.ttsNode(this, oneChunk(guarded.text), modelSettings);
  }
}

/** Re-wraps the guarded text as the single-chunk stream ttsNode expects. */
async function* oneChunk(text: string): AsyncIterable<string> {
  yield text;
}

/**
 * Keeps the conversation history bounded, WITHOUT invalidating a preemptive draft.
 *
 * Why bother: the entire call is re-sent to the LLM on every turn, so input tokens grow
 * QUADRATICALLY with call length. Measured on a real 3.5-minute call with no trimming at all:
 * 29,136 input tokens. A fifteen-minute call would be far worse than 4x that.
 *
 * Why HERE and not in `onUserTurnCompleted`: this runs after a conversation item is committed —
 * i.e. between turns, when there is no preemptive draft in flight to invalidate. By the time the
 * next draft is snapshotted the context is already short, and the hook that used to shrink it no
 * longer exists, so `isEquivalent()` holds and the draft survives.
 *
 * Trimming was separately measured NOT to reduce latency (3836 -> 3055 input tokens moved LLM ttft
 * by 2ms). It is a COST lever only. That is exactly why it must not cost us a single millisecond of
 * the caller's time to collect — which is what the old placement did.
 *
 * `truncate()` always keeps the system prompt, so she never forgets who she is; she only forgets
 * the far end of a long conversation.
 */
async function trimHistory(agent: voice.Agent, maxItems: number): Promise<void> {
  // 0 = don't trim. THE DEFAULT, and deliberately so: a sliding window destroys OpenAI's prompt
  // cache (it caches the longest common PREFIX, and trimming makes the prefix move every turn).
  // Measured: 92% of the prompt cached with the history intact, 0% with a 16-item window.
  // See VOICE_MAX_HISTORY_ITEMS in env.ts.
  if (maxItems === 0) return;

  try {
    const before = agent.chatCtx.items.length;
    if (before <= maxItems) return;
    const trimmed = agent.chatCtx.copy();
    trimmed.truncate(maxItems);
    await agent.updateChatCtx(trimmed);
    // Logged because the FIRST version of this silently did nothing: the invalidation warnings
    // stopped, so it looked fixed, while input tokens still climbed 712 -> 17,147 across a call.
    // A trim you cannot see is a trim you cannot trust.
    console.log(`trim_history before=${before} after=${agent.chatCtx.items.length} max=${maxItems}`);
  } catch (err) {
    // Never fail a live call over a cost optimisation.
    console.error('trim_history_failed', err instanceof Error ? err.message : String(err));
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

    // Everything we learn about this call, written to call-reports/ when it ends.
    // Read it with `npm run call:report`. Until this existed, the only record of a call was the
    // agent's stdout — which meant the person whose calls these are could not look at his own data.
    const report = new CallReport(ctx.room.name ?? 'unknown', caller.callerPhone, {
      sttProvider: env.STT_PROVIDER,
      sttModel: env.STT_PROVIDER === 'soniox' ? env.SONIOX_MODEL : env.OPENAI_REALTIME_MODEL,
      turnDetection: env.VOICE_TURN_DETECTION,
      llmModel: env.VOICE_LLM_MODEL ?? env.AI_MODEL,
      ttsModel: env.CARTESIA_MODEL,
    });

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

      // PROMPT CACHE HITS, per turn. OpenAI caches the longest common PREFIX of a prompt (1024
      // tokens minimum) and charges a fraction for the cached part. There is NO parameter to switch
      // this on — it is automatic, and `cache_control` is Anthropic's API, not OpenAI's. The only
      // thing you can do is avoid BREAKING it, which we were doing: a sliding history window moves
      // the prefix every turn and the hit rate collapses to zero.
      //
      // So this is the number that tells you whether the cache is alive. If cached=0 on a
      // mid-conversation turn, something is churning the prefix and both cost and prefill latency
      // are paying for it.
      if (typeof m.promptTokens === 'number') {
        const cached = typeof m.promptCachedTokens === 'number' ? m.promptCachedTokens : 0;
        const pct = m.promptTokens > 0 ? Math.round((cached / (m.promptTokens as number)) * 100) : 0;
        timings.push(`in=${m.promptTokens}`, `cached=${cached}`, `cacheHit=${pct}%`);
      }

      if (timings.length > 0) {
        ctx.proc.userData.lastMetricsAt = Date.now();
        report.recordMetric(stage, m);
        console.log(`latency ${stage} ${timings.join(' ')}`);
      }
    });

    // Per-call usage, so cost is a measured number and not an estimate. LiveKit tallies LLM
    // tokens, STT audio seconds and TTS characters for us; we just have to listen. Without this
    // the only way to cost a call is to guess at token counts from the transcript.
    // PHASE 4 will persist this alongside the transcript in call_learnings.
    session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, (ev) => {
      report.recordUsage(ev.usage ?? ev);
      console.log('call_usage', JSON.stringify(ev.usage ?? ev));
    });

    // SHADOW MODE — the candidate STT listens to the real caller and says nothing.
    //
    // Everything here is best-effort and cannot fail the call. If the shadow engine won't start,
    // the call runs exactly as if the flag were off. See stt/shadow-stt.ts for the safety contract:
    // separate audio stream, separate engine, every path try/caught, breaker on the candidate.
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
    }

    // Write the call report when the call ends. This is the ONLY durable record of a call today —
    // the call_learnings row it really belongs in is Phase 4, and the payload shape here matches
    // that column exactly so the move is a one-liner.
    ctx.addShutdownCallback(async () => {
      if (shadow) report.attachShadow(shadow.snapshot());

      // STDOUT, not just a file. In LiveKit Cloud the container's filesystem is ephemeral and
      // unreachable — `call-reports/*.json` is written into a box nobody can open. The first cloud
      // call proved it: the agent dutifully logged "call_report_written call-reports/...json" for a
      // file that could never be read. Stdout is the ONLY channel out of a cloud worker, and
      // `lk agent logs` is how it gets here. `npm run call:report -- --cloud` pulls these back down.
      //
      // The file is still written too, for the local dev path where it is genuinely readable.
      console.log(`call_report_json ${JSON.stringify(report.toJson())}`);

      const path = await report.write(CALL_REPORTS_DIR);
      if (path) console.log('call_report_written', path);
    });

    const agent = new ClickScalesAgent({ instructions: SYSTEM_PROMPT_HE });

    // One event, three jobs — all of which have to happen AFTER a turn is committed.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      // 1. The transcript: BOTH sides of the conversation.
      //    We used to record only what she HEARD, never what she SAID — so the call record was
      //    half a conversation, and useless for judging whether she actually answered the question.
      const item = ev.item as { role?: string; textContent?: string };
      if (item?.role && item?.textContent) {
        report.recordTranscript(item.role, item.textContent);
      }

      // 2. Trim the history — HERE, between turns, and never inside onUserTurnCompleted, where it
      //    invalidated LiveKit's preemptive draft on every single turn. See trimHistory().
      void trimHistory(agent, env.VOICE_MAX_HISTORY_ITEMS);

      // 3. FLUSH THE REPORT AFTER EVERY TURN, not just at shutdown.
      //
      //    The report used to be written only from addShutdownCallback. A worker that is killed —
      //    which is exactly what happens every time we restart it to change a setting — never runs
      //    that hook, and the ENTIRE call is lost. It happened: a real call was made, the agent was
      //    restarted, and the transcript went with it. We could no longer answer the only question
      //    that mattered ("did she chop his sentences?"), and there is no way to get it back short
      //    of asking him to call again.
      //
      //    Rewriting a few KB of JSON per turn is free. Losing a caller's data is not.
      void report.write(CALL_REPORTS_DIR);
    });

    // SHE HUMS WHEN SHE IS THINKING, but only when she is thinking for a LONG time.
    //
    // Koren, mid-call: "סיימת? אני פשוט לא מדבר, אני מחכה שתסיימי." He could not tell whether she
    // was thinking or had stopped, so he sat in silence waiting for a machine that was also silent.
    // A person facing a hard question takes just as long — but they fill the gap, and nobody minds.
    //
    // THE THRESHOLD IS THE DESIGN. Median LLM first-token is ~767ms; a threshold below ~1000ms would
    // make her hum on EVERY turn, which is much worse than silence — it becomes a tic, and a tic is
    // the fastest way to sound like a machine again. At 1200ms she only hesitates on the genuinely
    // slow turns, which is exactly when a person would.
    //
    // The filler NEVER enters the chat context (`addToChatCtx: false`). If it did, the LLM would see
    // "אממ..." as one of her own turns and start replying to it.
    //
    // Honest cost: once the filler starts, the real answer queues behind it. This does not make the
    // wait shorter — it makes it HUMAN. That was the ask.
    let fillerTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFiller: string | null = null;
    let fillerCount = 0;
    let lastFillerAt = 0;

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (fillerTimer) {
        clearTimeout(fillerTimer);
        fillerTimer = null;
      }
      if (env.VOICE_THINKING_FILLER_MS === 0 || ev.newState !== 'thinking') return;

      // A HARD CEILING, not just a threshold. The threshold alone fired 21 times in one seven-minute
      // call — every other turn, because the v2 prompt is long and the LLM crosses it constantly.
      // Koren: "she express too many times the thinking words and phrases." A person hesitates once
      // or twice in a conversation. Twenty-one times is a nervous tic, and it makes her sound LESS
      // human, which is the exact opposite of the point.
      if (fillerCount >= MAX_FILLERS_PER_CALL) return;
      if (Date.now() - lastFillerAt < FILLER_COOLDOWN_MS) return;

      fillerTimer = setTimeout(() => {
        fillerTimer = null;
        try {
          const filler = pickThinkingFiller(lastFiller);
          lastFiller = filler;
          // allowInterruptions: the caller may start speaking over the hesitation, and she must
          // yield to him instantly — hesitating AND talking over him would be the worst of both.
          fillerCount++;
          lastFillerAt = Date.now();
          session.say(filler, { addToChatCtx: false, allowInterruptions: true });
          console.log(
            `thinking_filler ${JSON.stringify({ filler, n: fillerCount, max: MAX_FILLERS_PER_CALL })}`,
          );
        } catch (err) {
          // A filler is a nicety. It must never be able to break a live call.
          console.error('filler_failed', err instanceof Error ? err.message : String(err));
        }
      }, env.VOICE_THINKING_FILLER_MS);
    });

    await session.start({
      agent,
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
