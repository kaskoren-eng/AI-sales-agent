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
import { callLearnings } from '../../../db/schema/index.js';
import { buildSessionComponents } from './agent.config.js';
import { CallReport } from './call-report.js';
import { hasAiDisclosure } from './compliance/ai-disclosure.js';
import { playRecordingNotice } from './compliance/recording-notice.js';
import { GREETING_HE, buildSystemPrompt } from './prompts/system-prompt.he.js';
import {
  FILLER_COOLDOWN_MS,
  MAX_FILLERS_PER_CALL,
  pickThinkingFiller,
} from './prompts/thinking-fillers.he.js';
import { guardStream, withFiller } from './speech-guard.js';
import { ShadowSTT } from './stt/shadow-stt.js';
import { DeepdubTTS } from './tts/deepdub.tts.js';
import { buildAgentTools } from './tools/index.js';
import { buildToolRuntime, type ToolRuntimeContext } from './tools/tool-context.js';

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
   * A hesitation to put at the FRONT of her next reply — never as an utterance of its own.
   *
   * THE FIRST VERSION SAID IT WITH session.say(), AND IT LANDED IN THE WRONG PLACE ENTIRELY.
   * `say()` QUEUES speech, so the filler played whenever the queue got to it — which was AFTER
   * whatever she was already saying. Koren heard it exactly that way: "היא עושה קולות של חשיבה
   * אחרי שהיא מסיימת לדבר." The log agrees:
   *
   *     היא מדברת (1152ms)
   *     >>> FILLER: אה...      <- fired the instant she stopped talking
   *     GPT חושב
   *     היא מדברת (3876ms)
   *
   * A person hesitating AFTER they have finished their sentence is not thinking. It is a twitch.
   *
   * He said where it belongs: "בהתחלה של הדיבור שלה אם היא צריכה לעבד משהו ארוך, או באמצע שהיא
   * אומרת משהו וצריכה לעצור לחשוב." So it is no longer spoken at all — it is PREPENDED to the reply
   * in ttsNode, which makes it the first sound of her next breath by construction. It cannot land
   * anywhere else.
   */
  pendingFiller: string | null = null;

  /** Null when the per-tenant tool gate is closed — the guard then behaves exactly as pre-Phase-4. */
  readonly toolRuntime: ToolRuntimeContext | null;

  constructor(opts: ConstructorParameters<typeof voice.Agent>[0], toolRuntime: ToolRuntimeContext | null = null) {
    super(opts);
    this.toolRuntime = toolRuntime;
  }

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
   * GUARDED SENTENCE BY SENTENCE, NOT REPLY BY REPLY.
   *
   * The first version buffered the ENTIRE reply before synthesis and cost 718ms on every single turn
   * (LLM first token 1020ms; full reply 1738ms). Koren heard it immediately. Making her slower on
   * every turn to defend against something she says on one turn is a bad trade, and I made it
   * without measuring the cost first.
   *
   * Sentence granularity is not a compromise — it is the correct granularity. Every pattern we guard
   * lives inside a single sentence: NO_RESPONSE_NEEDED is a whole utterance, and "קבעתי לך שיחת דמו"
   * cannot straddle a full stop. Holding more text than one sentence buys nothing and costs ~700ms.
   *
   * PHASE 4 UPDATE: the booking-claim rewrite is now CONDITIONAL, not deleted. The predicate is
   * `toolRuntime.bookingCompleted` — flipped by book_meeting the moment a REAL calendar event
   * exists. Until that moment (including on tools-enabled calls where nothing was booked yet),
   * "קבעתי לך" is still a lie and is still rewritten. After it, rewriting the truth would itself
   * be the lie. The control-token removal and the pronunciation fix stay unconditional forever.
   */
  override async ttsNode(
    text: Parameters<voice.Agent['ttsNode']>[0],
    modelSettings: voice.ModelSettings,
  ): ReturnType<voice.Agent['ttsNode']> {
    // The hesitation goes HERE — glued to the front of what she is about to say, so it is the first
    // sound out of her mouth and physically cannot arrive after she has finished. Consumed once.
    const filler = this.pendingFiller;
    this.pendingFiller = null;

    return voice.Agent.default.ttsNode(
      this,
      guardStream(
        withFiller(filler, text as AsyncIterable<string>),
        // Read PER SENTENCE: book_meeting can succeed mid-reply, and the very next sentence
        // ("קבעתי לך ליום ראשון") must already be allowed through.
        () => this.toolRuntime?.bookingCompleted === true,
      ),
      modelSettings,
    );
  }
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
    const components = buildSessionComponents(env, vad);
    const session = new voice.AgentSession(components);

    // DeepDub's realtime advantage only exists on a WARM socket (cold connect ~550–1900ms, warm
    // TTFB ~460ms — measured). Open it NOW, in parallel with everything below; by the time the
    // greeting synthesizes, the handshake is long done. No-op for other TTS providers.
    if (components.tts instanceof DeepdubTTS) void components.tts.prewarm();

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
      // The report must name the engine that actually spoke — a DeepDub call labeled sonic-3
      // sends whoever reads the latency numbers chasing the wrong provider.
      ttsModel: env.VOICE_TTS_PROVIDER === 'deepdub' ? `deepdub/${env.DEEPDUB_MODEL}` : env.CARTESIA_MODEL,
    });

    // LEGAL PRE-ROLL, started FIRST and awaited just before the greeting: the recorded-call
    // notice (Wiretapping Law 1979 §2) plays from a static asset in a flat broadcast voice —
    // deliberately not Keren's — while everything below (the tenant flag read, provider
    // construction, session start) warms up in parallel. The notice costs the caller nothing.
    const noticePromise = playRecordingNotice(ctx.room);

    // PHASE 4 — may this call use tools? One tenant-settings read, timeboxed at 2s, FAIL-CLOSED:
    // if the tenant can't be identified (outbound metadata → VOICE_WEBHOOK_TENANT_ID fallback) or
    // `voice_engine`/`functions_enabled` don't both say yes, `runtime` is null and the call runs
    // exactly as it did before Phase 4 — no tools, speech-guard fully armed. See tool-context.ts.
    const { runtime, disabledReason } = await buildToolRuntime(env, {
      callId: ctx.room.name ?? 'unknown',
      callerPhone: caller.callerPhone,
      participantMetadata: participant.metadata,
      report,
    });
    console.log(
      runtime
        ? `tools_enabled ${JSON.stringify({ tenantId: runtime.tenantId, leadId: runtime.leadId })}`
        : `tools_disabled reason=${disabledReason}`,
    );

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

      // Settle the AI-disclosure verdict from what was actually SAID (deterministic transcript
      // scan): 'during_call' | 'at_end' | 'missed'. A 'missed' means the goodbye instruction was
      // ignored — that's an audit finding, not a formality.
      report.resolveAiDisclosure(hasAiDisclosure);

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

      // PHASE 4: the durable record the CallReport header always promised — a call_learnings row,
      // written through the tool runtime's DB connection. This is what the weekly review, the
      // dashboard and call-analysis read; the JSON file above is the local-dev convenience copy.
      // Best-effort by design: losing the row must not crash teardown (the stdout JSON line above
      // still carries everything, and `lk agent logs` can recover it).
      if (runtime) {
        try {
          const json = report.toJson();
          await runtime.db.insert(callLearnings).values({
            tenantId: runtime.tenantId,
            conferenceName: (ctx.room.name ?? 'unknown').slice(0, 64),
            transcript: json.transcript.map((t) => ({
              speaker: t.role,
              text: t.text,
              start: t.atMs / 1000,
            })),
            shadowSttTranscript: json.shadow ?? undefined,
            analysis: {
              // Instrumentation rule: every tool call, with duration, lands here — the <500ms
              // budget and the end reason are read from this column, not from grep.
              tool_calls: json.toolCalls.map(({ atMs, name, durationMs, ok, error }) => ({
                atMs,
                name,
                durationMs,
                ok,
                ...(error ? { error } : {}),
              })),
              ...(runtime.endReason ? { end_reason: runtime.endReason } : {}),
              // Provable compliance, per call: recording notice + AI disclosure verdicts.
              ...json.compliance,
            },
            durationSecs: json.durationSec,
            status: 'pending',
            label: 'livekit',
          });
          console.log('call_learnings_written', JSON.stringify({ tenantId: runtime.tenantId }));
        } catch (err) {
          console.error('call_learnings_write_failed', err instanceof Error ? err.message : String(err));
        }

        // The pool closes LAST, after the row it exists to write.
        await runtime.closeDb().catch((err: unknown) => {
          console.error('tool_runtime_db_close_failed', err instanceof Error ? err.message : String(err));
        });
      }
    });

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

    // Tools only exist when the per-tenant gate said yes — and the PROMPT always agrees with the
    // tool set (a prompt naming tools the model doesn't have makes it improvise; tools the prompt
    // never mentions never get used). The tool set is FIXED for the whole call — never mutate it
    // (or chatCtx) mid-call, that invalidates preemptive generation.
    const agent = new ClickScalesAgent(
      {
        instructions: buildSystemPrompt({ toolsEnabled: runtime !== null }),
        ...(runtime ? { tools: buildAgentTools(runtime) } : {}),
      },
      runtime,
    );

    // SHE HESITATES WHEN SHE IS THINKING — AT THE START OF HER REPLY, NEVER AFTER IT.
    //
    // This does NOT speak. It ARMS a hesitation, which ttsNode then glues to the front of her next
    // reply. The first version used session.say(), which QUEUES speech — so the filler played after
    // whatever she was already saying, i.e. at the END of her turn. Koren: "היא עושה קולות של חשיבה
    // אחרי שהיא מסיימת לדבר, זה לא תקין." He was right; a person who hesitates after finishing their
    // sentence is not thinking, they are twitching.
    //
    // THE THRESHOLD IS STILL THE DESIGN. Below ~2s she would hesitate on nearly every turn, which is
    // a tic and worse than silence. The ceiling (3 per call) and the cooldown exist because the
    // threshold alone was not enough: it fired 21 times in one call.
    let fillerTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFiller: string | null = null;
    let fillerCount = 0;
    let lastFillerAt = 0;

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (fillerTimer) {
        clearTimeout(fillerTimer);
        fillerTimer = null;
      }
      // She stopped thinking without needing to hesitate — throw the armed filler away, or it would
      // surface on some LATER reply that arrived instantly and needed no hesitation at all.
      if (ev.newState !== 'thinking') {
        agent.pendingFiller = null;
        return;
      }
      if (env.VOICE_THINKING_FILLER_MS === 0) return;
      if (fillerCount >= MAX_FILLERS_PER_CALL) return;
      if (Date.now() - lastFillerAt < FILLER_COOLDOWN_MS) return;

      fillerTimer = setTimeout(() => {
        fillerTimer = null;
        const filler = pickThinkingFiller(lastFiller);
        lastFiller = filler;
        fillerCount++;
        lastFillerAt = Date.now();
        // ARMED, not spoken. ttsNode puts it at the front of the reply that is still being written.
        agent.pendingFiller = filler;
        console.log(
          `thinking_filler ${JSON.stringify({ filler, n: fillerCount, max: MAX_FILLERS_PER_CALL, armed: true })}`,
        );
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

    // The legal notice must FINISH before Keren opens her mouth — two voices at once is chaos,
    // and a notice she talked over is a notice that wasn't given. Its outcome is recorded either
    // way: `recording_notice_played` in call_learnings.analysis is the provable-compliance bit.
    const noticeAt = await noticePromise;
    report.recordCompliance({
      recording_notice_played: noticeAt !== null,
      ...(noticeAt ? { recording_notice_at: noticeAt } : {}),
    });
    console.log('recording_notice', JSON.stringify({ played: noticeAt !== null, at: noticeAt }));

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

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    // Phase 4 made the child runner's import graph heavy (googleapis + drizzle for the calendar
    // tools). Under tsx watch on Windows, cold-compiling that graph blows the default 10s
    // initialization budget and every dispatch dies with "runner initialization timed out"
    // before the agent ever joins the room. The cost is per-worker-boot, not per-call.
    initializeProcessTimeout: 60_000,
  }),
);
