// MUST BE THE FIRST IMPORT IN THIS FILE. It runs dotenv (by importing config/env.js) and then
// applies the `VOICE_TEST_OVERLAY` A/B variant on top of it, so every module imported below —
// and every later loadEnv() anywhere — reads the overlaid values. Moving it down silently
// disables A/B variants; it is a no-op when VOICE_TEST_OVERLAY is unset, i.e. in production.
import './testing/env-overlay.js';
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
import { buildSessionComponents, buildTTS, describeTtsModel, resolveBaseSpeed } from './agent.config.js';
import {
  describeDispatch,
  isJobChildProcess,
  isLocalCommand,
  resolveWorkerAgentName,
} from './testing/dev-dispatch.js';
import { finalizeTranscriptNow } from './stt/soniox.stt.js';
import { CallReport } from './call-report.js';
import {
  PreemptiveObserver,
  type SessionLike,
  describePipeline,
  formatPipelineLog,
  probeNoiseCancellation,
} from './pipeline-observer.js';
import { probeDatabase } from './db-probe.js';
import { CallStateMachine } from './call-state.js';
import { decideSilenceAction, decideVoicemailAction, silenceNudgeWaitMs } from './call-reflexes.js';
import { HOLD_CHECKBACK_HE } from './call-state-lines.he.js';
import { hasAiDisclosure } from './compliance/ai-disclosure.js';
import { NOT_IN_SERVICE_PATH, playRecordingNotice } from './compliance/recording-notice.js';
import { SPOKEN_REGISTER_SLANG, buildSystemPrompt, readBusinessProfile } from './prompts/system-prompt.he.js';
import { buildGreeting, isDefaultPersona, readAgentPersona } from './persona.js';
import { buildVoicemailMessage } from './call-state-lines.he.js';
import { MAX_FILLERS_PER_CALL, ThinkingFillerLedger } from './prompts/thinking-fillers.he.js';
import { SpokenOpenerTracker, observeFirstOpener } from './spoken-openers.js';
import {
  allowsArmedFiller,
  chooseTurnOpener,
  chunkCallsTool,
  type TurnOpener,
} from './turn-opener.js';
import { speedFor, type VoiceMode } from './voice-mode.js';
import { DICTATION_NODS, isDictationTurn } from './dictation.js';
import {
  EngagementTracker,
  callerSharedSubstance,
  callerTurnNeedsThinkingTime,
  latestCallerText,
} from './engagement.js';
import { EmailDictation } from './email-dictation.js';
import { NameDictation } from './name-dictation.js';
import { bookingNote } from './booking-note.js';
import {
  AddressGenderTracker,
  dropAckEcho,
  guardStream,
  notifyIfSilent,
  timeFirstChunk,
  withFiller,
} from './speech-guard.js';
import { PhraseLedger } from './phrase-ledger.js';
import { SalesGate } from './sales-gate.js';
import { SpokenSentenceLedger } from './repeat-guard.js';
import { SlotMemory } from './slot-memory.js';
import { FactMemory } from './fact-memory.js';
import { SpokenRegisterTracker } from './register-tracker.js';
import {
  ACKNOWLEDGEMENTS_HE,
  ACKNOWLEDGEMENTS_HE_WIDE,
  AcknowledgementLedger,
  pickAcknowledgement,
} from './prompts/acknowledgements.he.js';
import { ShadowSTT } from './stt/shadow-stt.js';
import { DeepdubTTS } from './tts/deepdub.tts.js';
import { buildAgentTools } from './tools/index.js';
import { runEndCallTeardown } from './tools/end-call.tool.js';
import { buildToolRuntime, isDidRefusal, type ToolRuntimeContext } from './tools/tool-context.js';
import { enqueueLiveKitCallAnalysis } from '../../../queues/call-analysis.queue.js';
import { meterCall } from '../../billing/usage.service.js';
import { ensureAgentSideConversation } from './call-record.js';

/** Where every call's report lands. Repo-root relative, gitignored — these contain caller PII. */
const CALL_REPORTS_DIR = 'call-reports';

/**
 * LiveKit voice agent — the production voice engine.
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

  /**
   * The call's hesitation budget, shared by BOTH spenders — the 2.5s think-timer below and the
   * turn opener in `llmNode`. One ledger, so they cannot double-spend the ceiling or echo each
   * other's word. Spent only when a filler is actually spoken (see withFiller's `onUsed`).
   */
  readonly fillerLedger = new ThinkingFillerLedger();

  /**
   * Did the PREVIOUS inference step of this reply emit a tool call?
   *
   * This is the whole signal behind chooseTurnOpener. A reply that calls a tool is two (or more)
   * inference steps with a DB round-trip between them, and each step runs `llmNode` — so without
   * this flag every step injects its own acknowledgement and the caller hears two receipts around
   * a multi-second hole. See turn-opener.ts for the transcript that proves it.
   */
  #lastStepCalledTool = false;

  /**
   * Called when a whole reply was guarded down to nothing — she is about to stay silent.
   *
   * Deliberate silence is a REAL feature (the caller asked her to hold), but it has no exit of its
   * own: nothing in the pipeline distinguishes "quiet on purpose" from "dead". On 2026-08-16 that
   * cost twenty seconds of a live call. Whoever sets this arms the way back out.
   */
  onSilentReply: (() => void) | null = null;

  /**
   * Called when a tool-call / JSON payload was cut out of her speech before it reached the TTS.
   *
   * Wired to the call report's counter, so a leak is a NUMBER on the call rather than something
   * you have to notice while reading a transcript. It should read zero on every call; the one
   * occurrence we know of (2026-08-31 13:52, 19 seconds of spoken JSON) is what built the guard.
   * See toolcall-leak.ts.
   */
  onSpeechLeak: ((reasons: readonly string[]) => void) | null = null;

  /** A claim that the meeting was already booked, rewritten before it was spoken. Counted on the
   * call for the same reason a leak is: its absence is the news. See FALSE_BOOKING_WIDE. */
  onFalseBookingClaim: ((spoken: string) => void) | null = null;

  /** The second question in one reply, dropped before it was spoken (Koren's conclusion 6). */
  onSecondQuestionDropped: ((spoken: string) => void) | null = null;

  /** A sentence narrating her own instructions/register, dropped (Koren's conclusion 8). */
  onSelfNarrationDropped: ((spoken: string) => void) | null = null;

  /** A sentence she had already said on this call, suppressed. See repeat-guard.ts. */
  onRepeatedSentenceDropped: ((spoken: string) => void) | null = null;

  /** She described the product before Gate A opened. Counted, never blocked — see sales-gate.ts. */
  onGateAViolation: ((spoken: string) => void) | null = null;

  /** Which register this step was synthesized in, once per step. See voice-mode.ts. */
  onVoiceMode: ((mode: VoiceMode) => void) | null = null;

  /** A mode marker reached the wide net still intact. Must be zero — see voice-mode.ts. */
  onModeMarkerLeak: ((spoken: string) => void) | null = null;

  /** An unbacked "let us stop here", rewritten into the confirmation question. */
  onStopAnnouncementRewritten: ((spoken: string) => void) | null = null;

  /** Slang inside a product claim, swapped for `מעולה` (round-13 s2). */
  onProductClaimSlangRewritten: ((spoken: string) => void) | null = null;

  /**
   * The MODEL's real time-to-first-token, which the SDK's own metric can no longer see.
   *
   * `performLLMInference` stamps `data.ttft` on the first chunk out of `llmNode`
   * (generation.js:381) — and with VOICE_INSTANT_ACK that chunk is OUR acknowledgement, emitted
   * before the model has done anything. So `llmTtftMedianMs` in the call report reads ~0ms and the
   * ~840ms it used to report vanishes from the instrument.
   *
   * That is the exact failure this session spent three days undoing (a metric that flatters the
   * change being measured), so it is not acceptable to introduce one. This reports the real
   * number, measured from reply start to the model's first chunk.
   */
  onModelFirstToken: ((ms: number) => void) | null = null;

  /** Null when the per-tenant tool gate is closed — the guard then behaves exactly as pre-Phase-4. */
  readonly toolRuntime: ToolRuntimeContext | null;

  /** Speak an instant acknowledgement at the start of every reply. See llmNode below. */
  readonly instantAck: boolean;

  /**
   * How long the CALLER has been waiting, asked at the moment we hand text to the voice.
   *
   * `latency audio_path` measures the reply against its own start, and by that clock the
   * acknowledgement leaves in 1-2ms. That reads as success and is not: on the 2026-08-18 call dead
   * air ran to a median of 1254ms while end-of-turn (200ms) + TTS (229ms) predicts ~430ms. The
   * ~800ms is unaccounted for because no instrument spans the join — one clock starts when the
   * reply starts, the other when the caller stops, and nothing measured the distance between them.
   * This closes it: if the guard's first chunk is already 1000ms into the caller's silence, the
   * reply was STARTED late and no amount of pipeline tuning will help.
   */
  msSinceUserStopped: (() => number | null) | null = null;

  /**
   * Which gender table the pronunciation fix speaks. Masculine by default; follows the LATEST
   * unambiguous evidence in either direction — her own conjugation (תרצי / אתה) via guardStream,
   * and the caller saying it outright ("אני אישה") via the ConversationItemAdded hook below.
   * One per call by construction: the agent instance is created per session, so a new call
   * starts masculine. See AddressGenderTracker in speech-guard.ts for the full rules.
   */
  readonly genderTracker = new AddressGenderTracker();

  /**
   * What she has already said this call, as 4-grams — the anti-repetition ledger
   * (VOICE_PHRASE_LEDGER_ENABLED). Fed from committed assistant items; its note is injected at
   * turn boundaries by injectPhraseNote() below. One per call, like the gender tracker.
   */
  readonly phraseLedger = new PhraseLedger(SPOKEN_REGISTER_SLANG);

  /**
   * What the call already knows, and what she has already asked for (VOICE_FACT_MEMORY_ENABLED).
   *
   * Shared with the tool runtime — see fact-memory.ts. The agent feeds it her committed questions;
   * capture_lead_info feeds it the answers and reads it before letting a name be replaced.
   * `undefined` when the switch is off, and every reader is written for that.
   */
  readonly factMemory: FactMemory | undefined;

  /**
   * Whether she is actually using the spoken register (VOICE_REGISTER_NUDGE_ENABLED).
   *
   * Two touches in eight turns on 2026-08-29, and the person on the call perceived none. The
   * tracker notices a dry streak and its note rides the same turn-boundary injection as the phrase
   * ledger's. `undefined` when the nudge is off, or when the register section itself is off — a
   * reminder to use a section she was never given would be nonsense.
   */
  readonly registerTracker: SpokenRegisterTracker | undefined =
    env.VOICE_REGISTER_NUDGE_ENABLED && env.VOICE_SPOKEN_REGISTER_ENABLED
      ? new SpokenRegisterTracker()
      : undefined;

  /**
   * The email being spelled out right now (VOICE_EMAIL_DICTATION_ENABLED).
   *
   * Set after construction rather than through the constructor, like `onSilentReply` and
   * `onModelFirstToken`: it is fed from the same ConversationItemAdded hook and read only by the
   * coach note, so nothing in the class body needs it at construction time. `undefined` when the
   * switch is off, and every reader is written for that. See email-dictation.ts.
   */
  emailDictation: EmailDictation | undefined;

  /** Hebrew letters spelled for a NAME, stitched across turns. See name-dictation.ts. */
  nameDictation: NameDictation | undefined;

  /** The last coach note injected, so an unchanged note is never re-written into the ctx. */
  lastCoachNote: string | null = null;

  constructor(
    opts: ConstructorParameters<typeof voice.Agent>[0],
    toolRuntime: ToolRuntimeContext | null = null,
    instantAck = false,
    factMemory: FactMemory | undefined = undefined,
  ) {
    super(opts);
    this.toolRuntime = toolRuntime;
    this.instantAck = instantAck;
    this.factMemory = factMemory;
  }

  /**
   * The last gate before text becomes sound.
   *
   * Two things escaped on Koren's first Keren-v2 call, and neither is fixable by prompting — the
   * model was doing exactly what it was told:
   *
   *   - She spoke `NO_RESPONSE_NEEDED` ALOUD, in English, to a Hebrew caller who had asked her to
   *     hold on. The token is inherited from the previous voice platform, which intercepted it;
   *     nothing in our stack does, so it went straight to Cartesia and Cartesia read it out.
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
  /**
   * The caller's last COMMITTED utterance — the turn she is about to answer.
   *
   * Fed from the ConversationItemAdded hook, the same source and the same timing the gender tracker
   * uses (`observeUser`), so the classification reads what she actually heard rather than what the
   * model guessed. Only `isDictationTurn` reads it; if it is stale by one turn — the preemptive
   * draft case — the draft is discarded anyway (known-issues §14) and the real step sees the
   * committed text.
   */
  lastUserUtterance: string | null = null;

  /** The acknowledgement spoken on this reply, so ttsNode can drop the model's echo of it. */
  #spokenAck: string | null = null;

  /**
   * The opener THIS step put at the head of the reply, or `{ kind: 'silent' }`.
   *
   * Separate from `#spokenAck` because a NOD sets no ack (there is no echo to drop) and still
   * occupies the same position in the breath. ttsNode reads it to decide whether an armed
   * hesitation may share that breath. See the "TWO SOUNDS, ONE BREATH" note in ttsNode.
   */
  #opener: TurnOpener = { kind: 'silent' };

  /**
   * The delivery register THIS step will be synthesized in. Decided in llmNode, applied in ttsNode.
   *
   * Two inputs, in priority order. `afterToolCall` is the certain one — she has just been off
   * checking a calendar, and the code knows that before a single word is synthesized, so the
   * slower rate lands on the same turn. Everything else comes from the marker the MODEL declared,
   * which arrives after this step's stream was already opened and therefore applies from the next
   * one. See voice-mode.ts for why that split is forced rather than chosen.
   */
  #turnMode: VoiceMode = 'confident';

  /**
   * What she declared with a `[[H]]` / `[[E]]` marker, carried to the next step of the SAME turn.
   *
   * Cleared when the caller speaks again: a register is a property of one answer, and a hesitation
   * declared three turns ago is not a hesitation now. Reset in ConversationItemAdded.
   */
  #declaredMode: VoiceMode | null = null;

  /**
   * The speech rate this call runs at before any register is applied — tenant override included.
   * Set once at construction; the modes multiply it. See resolveBaseSpeed in agent.config.ts.
   */
  baseSpeed = 1;

  /** Reset the declared register. Called when the caller starts a new turn. */
  clearDeclaredMode(): void {
    this.#declaredMode = null;
  }

  /** The register she asked for, from the speech guard. Applies to the next step of this turn. */
  noteDeclaredMode(mode: VoiceMode): void {
    this.#declaredMode = mode;
  }

  /**
   * The head-word of the PREVIOUS reply as the caller heard it — one per call.
   *
   * Koren, 2026-08-31: *"צריך לוודא שהסוכן לא חוזר על אותה מילה כל פעם בתחילת המשפט."* The
   * acknowledgement deck was measured innocent (see spoken-openers.ts); what was missing is that
   * the deck, the dictation nod, the thinking fillers and the model's own word all write to this
   * one position and none of them could see the others. This is the shared memory that makes the
   * comparison expressible at all.
   */
  readonly spokenOpeners = new SpokenOpenerTracker();

  #lastAck: string | null = null;

  /**
   * The acknowledgement deck (VOICE_ACK_LEDGER_ENABLED), one per call.
   *
   * `undefined` restores `pickAcknowledgement` over the original three-word bank — the behaviour
   * that produced six of eight turns opening with one of three words on 2026-08-29. The deck cannot
   * do that: it spends every word once before repeating any. See acknowledgements.he.ts.
   */
  readonly ackLedger: AcknowledgementLedger | undefined = env.VOICE_ACK_LEDGER_ENABLED
    ? // ON (the default): three every-turn receipts, plus two comprehension claims the caller has
      // to earn. OFF: the flat five-word deck of 2026-08-30, which is what Koren heard say
      // "טוב, הבנתי" thirty-four times. See ACK_COMPREHENSION_HE.
      env.VOICE_ACK_EARNED_ENABLED
      ? new AcknowledgementLedger()
      : new AcknowledgementLedger(ACKNOWLEDGEMENTS_HE_WIDE)
    : undefined;

  /**
   * How much the caller is giving her — read from his turn lengths, injected at turn boundaries.
   *
   * Feeds two things: which discovery questions she is allowed to ask (the mandatory/optional split
   * in the prompt), and nothing else. `undefined` when VOICE_ENGAGEMENT_NOTE_ENABLED is off, and
   * every reader is written for that. See engagement.ts.
   */
  readonly engagementTracker: EngagementTracker | undefined = env.VOICE_ENGAGEMENT_NOTE_ENABLED
    ? new EngagementTracker()
    : undefined;

  /**
   * WHAT SHE HAS DISCOVERED, and therefore whether she may describe the product yet.
   *
   * Gate A. `undefined` when VOICE_SALES_MODEL_ENABLED is off — the same flag that decides whether
   * the prompt carries the rule at all, so the note can never describe a rule she was not given.
   * See sales-gate.ts.
   */
  readonly salesGate: SalesGate | undefined = env.VOICE_SALES_MODEL_ENABLED
    ? new SalesGate()
    : undefined;

  /**
   * WHEN he said he wants the meeting (VOICE_SLOT_MEMORY_ENABLED), one per call.
   *
   * The field FactMemory does not have. She asked "בוקר, או אחר הצהריים?" four times on the
   * 2026-09-01 09:29 call, twice after he had answered, and he ended the call over it. Fed from
   * BOTH sides of the transcript — his answers and her asks — and its note rides the same
   * turn-boundary injection as the phrase ledger's. See slot-memory.ts.
   */
  readonly slotMemory: SlotMemory | undefined = env.VOICE_SLOT_MEMORY_ENABLED
    ? new SlotMemory()
    : undefined;

  /**
   * EVERY SENTENCE SHE HAS SENT TO THE TTS (VOICE_REPEAT_GUARD_ENABLED), one per call.
   *
   * Lives on the agent rather than inside `guardStream` because the guard is about the CALL, not
   * about one reply: the 2026-09-01 restarts were three separate replies four seconds apart, and
   * the two identical booking apologies were six. A per-reply ledger would have seen neither.
   * See repeat-guard.ts.
   */
  readonly spokenSentences = new SpokenSentenceLedger();

  /**
   * SAYS "אוקיי" THE INSTANT THE TURN ENDS, BEFORE THE MODEL HAS WRITTEN A WORD.
   *
   * This is the change that puts first audio under a second, and llmNode is the only place it can
   * live. Measured budget: end-of-turn ~400ms + LLM first token ~974ms + TTS first byte ~217ms.
   * The middle term cannot be tuned away — `npm run bench:path` shows the speech guard releasing
   * the opener 25ms after the first token, so the pipeline is already streaming correctly and the
   * wait is simply how long gpt-5.4 takes to start. A real answer cannot beat ~1.6s.
   *
   * WHY NOT `session.say()`, WHICH IS THE OBVIOUS WAY. Because it would land the acknowledgement
   * at the END of her reply, which is the exact bug this project already shipped once. The speech
   * queue is `[priority, insertion-time]` (agent_activity.js:2926) and `say()` has no priority
   * parameter, while the reply's handle is scheduled BEFORE `_updateAgentState('thinking')` fires
   * (agent_activity.js:~2035) — so anything we schedule from that event is behind it. Read the
   * scheduler, do not test this by ear on a phone call.
   *
   * llmNode has no such problem: its output IS the reply's text stream, so a string yielded here
   * is the first thing the TTS sees, in the same segment, ordered by construction. It also runs at
   * reply start rather than at first token, which is the whole point — Cartesia begins
   * synthesising while OpenAI is still thinking.
   */
  override async llmNode(
    chatCtx: Parameters<voice.Agent['llmNode']>[0],
    toolCtx: Parameters<voice.Agent['llmNode']>[1],
    modelSettings: Parameters<voice.Agent['llmNode']>[2],
  ): ReturnType<voice.Agent['llmNode']> {
    const startedAt = Date.now();
    const inner = await voice.Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
    if (!this.instantAck || inner === null) {
      // VOICE_INSTANT_ACK off = nothing is injected at all, which also means a tool-calling step
      // produces no text chunk, no TTS segment and therefore no orphaned word. The whole
      // turn-opener mechanism below exists to undo a problem the acknowledgement creates, so with
      // the acknowledgement off it has nothing to do.
      this.#spokenAck = null;
      this.#opener = { kind: 'silent' };
      return inner;
    }

    // WHICH WORD OPENS *THIS STEP* — and a step that follows a tool call gets a different answer.
    // See turn-opener.ts: one caller turn can be several inference steps, and injecting an
    // acknowledgement into each of them is what produced "אהה." … 5.4s … "אוקיי. כמה פניות…" on
    // the 2026-08-29 call. The flag is consumed here and re-set below if THIS step also calls a tool.
    const afterToolCall = this.#lastStepCalledTool;
    this.#lastStepCalledTool = false;
    // The turn the model is ANSWERING, read once and used by both of the 2026-09-01 rules that
    // depend on it: whether a comprehension claim is earned, and whether this turn needs a receipt
    // at all (Koren's conclusion 12). Both used to read `lastUserUtterance`, which is one turn
    // behind whenever a preemptive draft is used — see latestCallerText in engagement.ts.
    const currentCallerTurn = env.VOICE_ACK_EARNED_FROM_CONTEXT
      ? latestCallerText(
          (chatCtx as unknown as { items?: ReadonlyArray<{ role?: unknown; textContent?: unknown }> })
            .items,
        )
      : this.lastUserUtterance;
    // THE REGISTER THIS STEP IS SPOKEN IN, decided here because this is the earliest point that
    // knows anything and the last point before the synthesis stream is opened.
    //
    // `afterToolCall` outranks the declaration and that ordering is the whole reason the feature
    // works at all on the turn that matters most: she has just come back from checking a calendar,
    // the code knows it with certainty, and it knows it BEFORE a word is synthesized — so the
    // slower rate lands on this reply rather than the next one. A marker the model wrote is read
    // out of a stream that only starts after ttsNode has already opened Cartesia's, so it can only
    // take effect from the following step. See voice-mode.ts.
    if (env.VOICE_VOICE_MODES_ENABLED) {
      this.#turnMode = afterToolCall ? 'hesitant' : (this.#declaredMode ?? 'confident');
    }
    const opener = chooseTurnOpener({
      afterToolCall,
      fillersEnabled: env.VOICE_THINKING_FILLER_MS !== 0,
      // He is still reading out the number. A receipt here takes the floor from a man who has not
      // finished his sentence — see dictation.ts and the 050- / "טוב, הבנתי." exchange it quotes.
      midDictation: env.VOICE_DICTATION_NOD_ENABLED && isDictationTurn(this.lastUserUtterance),
      // The bank, not one word: Koren's round-11 verdict is three sounds used at random, and the
      // no-repeat filter inside chooseTurnOpener is the same `avoidOpener` every opening sound
      // goes through. See dictation.ts.
      nods: DICTATION_NODS,
      // The head-word of the previous reply, whatever produced it — see SpokenOpenerTracker. Null
      // switches the whole no-repeat rule off (VOICE_OPENER_NO_REPEAT_ENABLED), restoring the
      // 2026-08-31 behaviour exactly.
      avoidOpener: env.VOICE_OPENER_NO_REPEAT_ENABLED ? this.spokenOpeners.avoid : null,
      // Did he actually TELL her something? Only then may the receipt claim comprehension.
      //
      // READ FROM `chatCtx`, NOT FROM `lastUserUtterance`. The committed-turn field is one turn
      // BEHIND on every step where a preemptive draft is used (17 of 24 on the 2026-08-31 19:54
      // call), because llmNode runs during the end-of-turn wait and ConversationItemAdded fires
      // when the turn commits. That staleness — not the substance test — is why "טוב, הבנתי"
      // landed after four questions on that call; see latestCallerText in engagement.ts for the
      // four-for-four reconstruction. `chatCtx` is what the model is answering, so its last user
      // message is the current turn by construction.
      //
      // VOICE_ACK_EARNED_FROM_CONTEXT=false restores the stale source exactly. midDictation above
      // still reads the committed field and is DELIBERATELY not changed here: the dictation nod is
      // a behaviour Koren judged by ear on round 11, and this commit does not touch it.
      callerShared: env.VOICE_ACK_EARNED_ENABLED && callerSharedSubstance(currentCallerTurn),
      // KOREN'S CONCLUSION 12 — the receipt only on a turn whose reply needs the time it buys.
      // `true` when the switch is off, which is the every-turn behaviour that shipped.
      needsThinkingTime:
        !env.VOICE_ACK_ONLY_WHEN_NEEDED || callerTurnNeedsThinkingTime(currentCallerTurn),
      nextAck: (opts) =>
        this.ackLedger ? this.ackLedger.next(opts) : pickAcknowledgement(this.#lastAck),
      offerFiller: () => this.fillerLedger.offer(),
    });

    if (opener.kind === 'ack') {
      this.#lastAck = opener.word;
      this.#spokenAck = opener.word;
    } else {
      // Nothing for dropAckEcho to remove: a hesitation is not a word the model would echo.
      this.#spokenAck = null;
    }
    // ttsNode reads this to decide whether an armed hesitation may share the breath, and to record
    // what the caller heard at the head of the reply.
    this.#opener = opener;
    if (opener.kind === 'nod') {
      // Logged because it is invisible otherwise: the nod and the receipt are both one short word
      // at the head of a reply, and only this line says which act she performed.
      console.log(
        `turn_opener ${JSON.stringify({ kind: 'nod', word: opener.word, reason: 'caller_dictating' })}`,
      );
    }
    if (opener.kind === 'hesitation') {
      // Spoken here, at the head of the step, so it covers the tool round-trip that just happened
      // instead of arriving after it. It is therefore spent immediately — unlike the armed filler
      // in ttsNode, which is only spent if real words follow it.
      this.fillerLedger.commit(opener.word);
      // ...and never twice in one breath: the armed filler must not also land on this step.
      this.pendingFiller = null;
      console.log(
        `thinking_filler ${JSON.stringify({
          filler: opener.word,
          n: this.fillerLedger.used.length,
          max: MAX_FILLERS_PER_CALL,
          reason: 'after_tool_call',
          spoken: true,
        })}`,
      );
    }

    const reader = inner.getReader();
    let sawModelToken = false;
    const withAck = new ReadableStream({
      // Enqueued before the first read, so it reaches the TTS without waiting on the model at all.
      // 'silent' enqueues nothing: this call has spent its fillers and the caller has already been
      // acknowledged, so the honest sound is none at all.
      start: (controller) => {
        if (opener.kind !== 'silent') controller.enqueue(`${opener.word} `);
      },
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        // The model's real first token — see onModelFirstToken. The SDK's own ttft is now measuring
        // the acknowledgement above, so this is the only place the true number still exists.
        if (!sawModelToken) {
          sawModelToken = true;
          this.onModelFirstToken?.(Date.now() - startedAt);
        }
        // A tool call on THIS step means the next step is not a fresh turn — it is the same reply
        // resuming after a DB round-trip, and it must not acknowledge the caller a second time.
        if (chunkCallsTool(value)) this.#lastStepCalledTool = true;
        controller.enqueue(value as string);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    // The SDK types this channel as ChatChunk | string | FlushSentinel; we only ever add a string,
    // and pass every model chunk through untouched. The cast is over the union, not over behaviour.
    return withAck as unknown as NonNullable<Awaited<ReturnType<voice.Agent['llmNode']>>>;
  }

  override async ttsNode(
    text: Parameters<voice.Agent['ttsNode']>[0],
    modelSettings: voice.ModelSettings,
  ): ReturnType<voice.Agent['ttsNode']> {
    // The hesitation goes HERE — glued to the front of what she is about to say, so it is the first
    // sound out of her mouth and physically cannot arrive after she has finished. Consumed once.
    let filler = this.pendingFiller;
    this.pendingFiller = null;

    // TWO SOUNDS, ONE BREATH — and whether they go together, not how many there are.
    //
    // The transcript that started this: [21s] "טוב," … [23s] "אהה. רגע..." — an acknowledgement
    // from llmNode and an armed hesitation from the think-timer, glued together by `withFiller`'s
    // leadIn. We read Koren's note as a hard cap of one sound per breath and shipped that.
    //
    // He then LISTENED to the three versions (round-7 card `n4a`) and chose the double:
    // *"אהה ורגע יכולים להתאים ביחד, אבל רגע ושניה או רגע וחכה זה מילים שלא יכולות ללכת ביחד."*
    // So the cap is gone and `mayPairInOneBreath` is the rule — a receipt may be followed by a
    // hesitation (two different acts), two hesitations may never stack (the same act twice, which
    // is the stutter), and a nod classifies as a hesitation so it is refused by the same rule.
    // VOICE_FILLER_PAIRING_ENABLED=false restores the cap exactly. See turn-opener.ts.
    const opener = this.#opener;
    this.#opener = { kind: 'silent' };
    if (filler && !allowsArmedFiller(opener, filler, { pairing: env.VOICE_FILLER_PAIRING_ENABLED })) {
      console.log(
        `thinking_filler ${JSON.stringify({
          filler,
          dropped: 'sounds_do_not_pair',
          opener: opener.kind === 'silent' ? null : opener.word,
          spoken: false,
        })}`,
      );
      filler = null;
    }

    // WHAT THE CALLER WILL HEAR AT THE HEAD OF THIS REPLY, so the NEXT turn can avoid repeating it.
    // Our own sound when there is one, otherwise the armed hesitation, otherwise the model's first
    // word — observed below without buffering. See SpokenOpenerTracker.
    if (opener.kind !== 'silent') this.spokenOpeners.record(opener.word);
    else if (filler) this.spokenOpeners.record(filler);
    else this.spokenOpeners.record(null);
    const watchModelOpener = opener.kind === 'silent' && filler === null;

    // Both ends of the speech path, on one line per reply. See timeFirstChunk() for why: dead air
    // is end-of-turn + <something> + TTS first byte, and `<something>` behaved differently on a
    // short reply (218ms after the LLM's first token) than on a long one (1416ms). This says
    // whether our sentence buffering is the cost or whether the delay is downstream of us.
    const startedAt = Date.now();
    let llmFirstChunk = -1;

    // The acknowledgement is already committed to audio by the time the model writes its opener,
    // so if the model opens with the same word we cannot un-say ours — we drop theirs instead.
    const ack = this.#spokenAck;
    this.#spokenAck = null;

    // THE RATE, applied to the stream created on the very next line and to nothing else.
    //
    // Wired HERE for the same reason the tool-call leak guard is: everything that makes a sound
    // goes through ttsNode, `session.say()` and `RunContext.filler` included — so the reflex lines
    // and the "שנייה, אני בודקת את היומן" that book_meeting speaks are covered by one call site
    // rather than five kept in step by hand.
    //
    // `updateOptions?.` rather than a cast: the `inference` route does not build a cartesia.TTS at
    // all, and DeepDub's adapter has no speed control whatsoever. Both must degrade to "the mode
    // is text only", never to a crash mid-call.
    if (env.VOICE_VOICE_MODES_ENABLED) {
      const speed = speedFor(this.#turnMode, this.baseSpeed, env.VOICE_HESITANT_SPEED_FACTOR);
      (this.tts as { updateOptions?: (o: { speed: number }) => void } | undefined)?.updateOptions?.(
        { speed },
      );
      this.onVoiceMode?.(this.#turnMode);
    }

    const synthesized = await voice.Agent.default.ttsNode(
      this,
      notifyIfSilent(
        timeFirstChunk(
          guardStream(
            // withFiller wraps dropAckEcho, not the other way round: the hesitation belongs in
            // front of the MODEL's first words, and only dropAckEcho knows where those start. On a
            // step that never produces any (a tool call), withFiller drops the hesitation instead
            // of orphaning it — the 2026-08-29 "word … 5.4s … sentence" bug. The acknowledgement
            // still leaves first and unheld.
            withFiller(
              filler,
              dropAckEcho(
                ack,
                timeFirstChunk(
                  watchModelOpener
                    ? observeFirstOpener(text as AsyncIterable<string>, (word) =>
                        this.spokenOpeners.record(word),
                      )
                    : (text as AsyncIterable<string>),
                  startedAt,
                  (ms) => {
                    llmFirstChunk = ms;
                  },
                ),
              ),
              {
                leadIn: ack ? `${ack} ` : null,
                // Spent only now, when it has actually been spoken — see ThinkingFillerLedger.
                onUsed: () => {
                  if (!filler) return;
                  this.fillerLedger.commit(filler);
                  console.log(
                    `thinking_filler ${JSON.stringify({
                      filler,
                      n: this.fillerLedger.used.length,
                      max: MAX_FILLERS_PER_CALL,
                      reason: 'slow_reply',
                      spoken: true,
                    })}`,
                  );
                },
              },
            ),
            // Read PER SENTENCE: book_meeting can succeed mid-reply, and the very next sentence
            // ("קבעתי לך ליום ראשון") must already be allowed through.
            () => this.toolRuntime?.bookingCompleted === true,
            this.genderTracker,
            // Digits → colloquial Hebrew words in the SPOKEN text only (times, phones, prices).
            env.VOICE_SPEECH_NUMBERS_ENABLED,
            // "נעים מאוד" is the introduction, and there is only one of those per call. The latch
            // is set when her greeting COMMITS, so the first one passes and every later one is
            // removed. Read per sentence, like the booking claim above.
            (greetedInThisReply) =>
              !env.VOICE_INTRO_ONCE_ENABLED ||
              (!(this.factMemory?.introduced ?? false) && !greetedInThisReply),
            () => this.factMemory?.get('name') ?? null,
            // THE TOOL-CALL LEAK GUARD (2026-08-31). Wired HERE, in ttsNode, and nowhere else —
            // because everything that makes sound passes through this node. `session.say()` does
            // too (agent_activity.js `ttsTask` → `performTTSInference((...args) =>
            // this.agent.ttsNode(...args))`), so the reflex lines are covered by the same code as
            // the model's replies without a second call site to keep in step. See toolcall-leak.ts.
            {
              enabled: env.VOICE_TOOLCALL_LEAK_GUARD_ENABLED,
              onLeak: (reasons) => this.onSpeechLeak?.(reasons),
            },
            // THE FALSE-BOOKING REWRITE'S TWO KNOBS (2026-08-31). `possible` picks WHICH truth
            // replaces the claim: on a tools call that simply has not booked yet she is rewritten
            // into the next step ("I need a few more details first"), not into a handover to the
            // team — a handover mid-collection would say goodbye and then ask for his name.
            {
              possible: this.toolRuntime !== null,
              wide: env.VOICE_BOOKING_CLAIM_GUARD_WIDE,
              onFalseClaim: (spoken) => this.onFalseBookingClaim?.(spoken),
            },
            // THE TWO PER-REPLY RULES from the 2026-08-31 19:54 call (conclusions 6 and 8). Both
            // live at the stream level rather than in guardSpeech because both are facts about the
            // WHOLE reply: how many questions it asked, and — for the narration guard — nothing,
            // which is why only its flag passes through here. See guardStream's `reply` parameter.
            {
              oneQuestion: env.VOICE_ONE_QUESTION_ENABLED,
              onSecondQuestion: (spoken) => this.onSecondQuestionDropped?.(spoken),
              selfNarrationGuard: env.VOICE_SELF_NARRATION_GUARD_ENABLED,
              onSelfNarration: (spoken) => this.onSelfNarrationDropped?.(spoken),
              // THE 2026-09-01 09:29 ENDING PAIR. `endingRequested` is read PER SENTENCE like the
              // booking claim above, and it is true on TWO conditions rather than one: `endReason`
              // is set the moment `end_call` is allowed through the gate, and `bookingCompleted`
              // covers the legitimate wrap-up — the prompt has her say the goodbye BEFORE calling
              // end_call, so a booked call would otherwise have its farewell turned into a
              // question. Everything else that proposes a stop becomes the gate's own question.
              stopAnnounceGuard: env.VOICE_STOP_ANNOUNCE_GUARD_ENABLED,
              endingRequested: () =>
                this.toolRuntime?.endReason != null || this.toolRuntime?.bookingCompleted === true,
              onStopAnnouncement: (spoken) => this.onStopAnnouncementRewritten?.(spoken),
              productClaimSlangGuard: env.VOICE_PRODUCT_CLAIM_SLANG_GUARD,
              onProductClaimSlang: (spoken) => this.onProductClaimSlangRewritten?.(spoken),
              // The register marker: stripped here, read here, and counted here if it survived.
              voiceModes: env.VOICE_VOICE_MODES_ENABLED,
              onModeDeclared: (mode) => this.noteDeclaredMode(mode),
              onModeMarkerLeak: (spoken) => this.onModeMarkerLeak?.(spoken),
            },
            // THE ANTI-REPETITION GUARD. The ledger is the agent's, so it spans the whole call;
            // `lastCallerTurn` is read per sentence so "לא שמעתי" in the turn she is answering
            // still buys him the repeat he asked for. See repeat-guard.ts.
            {
              enabled: env.VOICE_REPEAT_GUARD_ENABLED,
              ledger: this.spokenSentences,
              lastCallerTurn: () => this.lastUserUtterance,
              onDropped: (spoken) => this.onRepeatedSentenceDropped?.(spoken),
            },
          ),
          startedAt,
          (ms) => {
            const waited = this.msSinceUserStopped?.() ?? null;
            console.log(
              `latency audio_path llmFirstChunk=${llmFirstChunk} guardFirstOut=${ms} ` +
                `heldMs=${ms - llmFirstChunk} sinceCallerStopped=${waited ?? -1}`,
            );
          },
        ),
        () => this.onSilentReply?.(),
      ),
      modelSettings,
    );

    // THE LAST BLIND SPOT, and the reason two theories in a row were wrong.
    //
    // We know the acknowledgement's TEXT reaches the voice ~530ms after the caller stops, and that
    // Cartesia reports ~240ms to first byte. That predicts sound at ~770ms. The caller waits
    // ~1690ms. Turning preemptive TTS off moved that by 180ms — i.e. it was not the cause, and I
    // had no instrument that could have told me so beforehand.
    //
    // `ttfbMs` is the TTS plugin's own stopwatch, started when IT decides to open the request. It
    // cannot see time spent before that, and neither could we. This times the first AUDIO FRAME
    // leaving the node against the CALLER's clock, which brackets the gap from both sides:
    //
    //   firstFrame ~= 800ms  -> audio exists on time and something downstream sits on it
    //   firstFrame ~= 1700ms -> the synthesis never started when we thought it did
    if (synthesized === null) return null;
    // `as unknown as` for the same reason llmNode does it: the SDK types this as node:stream/web's
    // ReadableStream while the global one is DOM's. Structurally identical, nominally not.
    return timeFirstAudioFrame(
      synthesized as unknown as ReadableStream<AudioFrame>,
      () => this.msSinceUserStopped?.() ?? null,
    ) as unknown as NonNullable<Awaited<ReturnType<voice.Agent['ttsNode']>>>;
  }
}

/**
 * Reports when the first audio frame of a reply left the TTS node, on the caller's clock.
 *
 * A passthrough with a counter — instrumentation that changes the timing it measures is worse
 * than none.
 */
function timeFirstAudioFrame(
  frames: ReadableStream<AudioFrame>,
  waited: () => number | null,
): ReadableStream<AudioFrame> {
  // EAGER, and that is the entire point. The first version used `pull`, which only advances when
  // the CONSUMER asks — so it timed when LiveKit played the frame, not when Cartesia produced it,
  // and duly reported a number identical to dead air on every single turn. That looked like proof
  // that nothing holds finished audio. It was proof of nothing but the shape of the wrapper.
  //
  // The SDK's own ttsNode drains its TTS with an eager `start` loop (agent.js:353), so consuming
  // eagerly here changes no buffering that was not already happening one layer down.
  const reader = frames.getReader();
  return new ReadableStream<AudioFrame>({
    start: async (controller) => {
      let seen = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!seen) {
            seen = true;
            console.log(`latency first_audio_frame sinceCallerStopped=${waited() ?? -1}`);
          }
          controller.enqueue(value as AudioFrame);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}


/**
 * The coach note's stable chat-item id — replaced in place on each injection.
 *
 * ONE item, not one per mechanism. Three advisory notes (phrasing variety, call memory, spoken
 * register) would otherwise be three tail items and three `updateChatCtx` round-trips per turn;
 * they are concatenated instead, so the tail grows by exactly one message however many mechanisms
 * have something to say. The id is unchanged from when this held only the phrase note — ids are
 * per-call, so nothing outlives the rename.
 */
const COACH_NOTE_ID = 'phrase-ledger-note';

/**
 * Injects (or refreshes) the per-turn advisory notes: "do not reuse these phrasings" (phrase
 * ledger), "you already know / already asked this" (fact memory) and the spoken-register nudge.
 *
 * WHERE AND WHY: called only from the ConversationItemAdded handler, after an ASSISTANT item
 * committed — the same safe point trimHistory uses. Her reply is done, the next preemptive draft
 * has not been snapshotted yet, so `isEquivalent()` holds on the next turn and no draft is ever
 * invalidated (mutating the ctx in onUserTurnCompleted was the documented way to silently kill
 * preemptive generation — this is the other way, the one that doesn't).
 *
 * CACHE SHAPE: the note is APPENDED at the tail as a system item; the previous note (1–2 items
 * from the tail) is removed first. OpenAI caches the longest common prompt PREFIX, so everything
 * before the old note's position — the system prompt and nearly all history — stays cached.
 * Rewriting the instructions instead would churn the prefix and collapse the 92% hit rate to
 * zero (measured, the sliding-window lesson).
 *
 * A call with nothing to correct never enters this function's update path at all — every note() is
 * null and the mechanism costs zero tokens.
 */
async function injectCoachNote(agent: ClickScalesAgent): Promise<void> {
  try {
    const phraseNote = env.VOICE_PHRASE_LEDGER_ENABLED ? agent.phraseLedger.note() : null;
    const factNote = agent.factMemory?.note() ?? null;
    // "You do not yet know his pain — do NOT describe the product." The discovery gate. Placed
    // with the memory notes because it is a statement about what is known, and read BEFORE the
    // engagement note so a terse caller is still gated: shortening the call is not permission to
    // pitch into a vacuum. See sales-gate.ts.
    const gateNote = agent.salesGate?.note() ?? null;
    // "He is giving you four-word answers — mandatory questions only." Fires on a CHANGE of level,
    // so a consistent caller costs one line for the whole call. See engagement.ts.
    const engagementNote = agent.engagementTracker?.note() ?? null;
    // "He has already told you when." Placed with the other memory notes rather than with the
    // booking note, because it is about what the CALLER said, not about what the tool needs.
    const slotNote = agent.slotMemory?.note() ?? null;
    const emailNote = agent.emailDictation?.note() ?? null;
    const nameNote = agent.nameDictation?.note() ?? null;
    // THE ONLY NOTE READ OFF THE TOOL RUNTIME RATHER THAN OFF THE TRANSCRIPT — what is actually
    // booked, and which of `book_meeting`'s required arguments still have no value. Last in the
    // list because it is the one that must not be argued with. See booking-note.ts.
    const rt = agent.toolRuntime;
    const bookNote =
      env.VOICE_BOOKING_NOTE_ENABLED && rt
        ? bookingNote({
            toolsEnabled: true,
            booked: rt.bookingCompleted,
            // `check_calendar_availability` sets lastCheckedDurationMinutes on every path; the
            // stage is the fallback for a call where the advisory state layer is switched off.
            scheduling:
              rt.lastCheckedDurationMinutes !== null ||
              rt.callState?.stage === 'scheduling' ||
              rt.callState?.stage === 'closing',
            name: agent.factMemory?.get('name') ?? null,
            phone: agent.factMemory?.get('phone') ?? null,
            callerPhone: rt.callerPhone,
            offerCallerPhone: env.VOICE_CALLER_PHONE_KNOWN_ENABLED,
          })
        : null;
    const note = [phraseNote, factNote, gateNote, slotNote, engagementNote, emailNote, nameNote, bookNote]
      .filter(Boolean)
      .join('\n');
    if (!note || note === agent.lastCoachNote) return;
    const ctx = agent.chatCtx.copy();
    ctx.items = ctx.items.filter((it) => it.id !== COACH_NOTE_ID);
    ctx.addMessage({ role: 'system', content: note, id: COACH_NOTE_ID });
    await agent.updateChatCtx(ctx);
    agent.lastCoachNote = note;
    console.log(
      `coach_note ${JSON.stringify({
        repeated4grams: agent.phraseLedger.repeatedGramCount,
        facts: agent.factMemory?.snapshot() ?? null,
        slot: agent.slotMemory?.snapshot() ?? null,
        registerTouched: agent.registerTracker
          ? `${agent.registerTracker.touched}/${agent.registerTracker.replies}`
          : null,
        engagement: agent.engagementTracker
          ? `${agent.engagementTracker.level} (${agent.engagementTracker.averageWords} words/turn)`
          : null,
        note: note.slice(0, 200),
      })}`,
    );
  } catch (err) {
    // Advisory mechanism — never fail a live call over a style reminder.
    console.error('coach_note_inject_failed', err instanceof Error ? err.message : String(err));
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

    // Say out loud whether this worker can reach its database. See db-probe.ts.
    await probeDatabase(env.DATABASE_URL);
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
    // WHICH WAY THIS CALL WENT. Read here rather than at the reflex layer 750 lines down, because
    // the PROMPT needs it: until 2026-09-01 Step 1 branched on a `{{call_direction}}` placeholder
    // that nothing ever substituted, so on a call the lead had dialled she asked him twice whether
    // she had caught him at a good time, and he corrected her twice (09:43). Malformed or absent
    // metadata means inbound SIP or console — the same assumption the reflex layer makes.
    const isOutboundCall = readCallDirection(participant.metadata);
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
      ttsModel:
        env.VOICE_TTS_PROVIDER === 'deepdub'
          ? `deepdub/${env.DEEPDUB_MODEL}`
          : env.VOICE_TTS_PROVIDER === 'elevenlabs'
            ? `elevenlabs/${env.ELEVENLABS_MODEL}`
            : env.CARTESIA_MODEL,
    });

    // DID PREEMPTIVE GENERATION ACTUALLY FIRE? Installed HERE, before anything can draft a reply,
    // and removed at teardown.
    //
    // The report already carried `draftsDiscarded`, and it could not answer the question: zero
    // reads the same whether every draft survived or none was ever made. LiveKit emits no event for
    // this — the only signals are three log messages inside AgentActivity, one of them at DEBUG
    // level, so the observer wraps the logger's methods rather than reading a stream. See
    // pipeline-observer.ts. Counting only; the log output is unchanged byte for byte.
    const preemptive = new PreemptiveObserver();
    preemptive.install();
    report.attachPreemptive(() => preemptive.snapshot());

    // LEGAL PRE-ROLL, started FIRST and awaited just before the greeting: the recorded-call
    // notice (Wiretapping Law 1979 §2) plays from a static asset in a flat broadcast voice —
    // deliberately not Keren's — while everything below (the tenant flag read, provider
    // construction, session start) warms up in parallel. The notice costs the caller nothing.
    //
    // DISABLED via VOICE_RECORDING_NOTICE_ENABLED (default off, Koren 2026-07-27): the choppy
    // PSTN playback is worse than none for the interim test phase. Code stays as-is; when off we
    // resolve immediately to null so compliance records played:false without touching the room.
    const recordingNoticeOn =
      env.VOICE_RECORDING_NOTICE_ENABLED === 'true' || env.VOICE_RECORDING_NOTICE_ENABLED === '1';
    const noticePromise: Promise<string | null> = recordingNoticeOn
      ? playRecordingNotice(ctx.room)
      : Promise.resolve(null);

    // PHASE 4 — may this call use tools? One tenant-settings read, timeboxed at 2s, FAIL-CLOSED:
    // if the tenant can't be identified (outbound metadata → VOICE_WEBHOOK_TENANT_ID fallback) or
    // `voice_engine`/`functions_enabled` don't both say yes, `runtime` is null and the call runs
    // exactly as it did before Phase 4 — no tools, speech-guard fully armed. See tool-context.ts.
    // The advisory conversation state machine — one per call (even on gate-closed calls, so the
    // silence/voicemail reflexes still work). The SAME instance is threaded into the tool runtime so
    // the tools advance it; the event handlers below close over this const. `undefined` when the
    // whole advisory layer is switched off (VOICE_STATE_MACHINE_ENABLED=false) — reflexes, tracking
    // and the objection prompt section all fall away, running Keren exactly as she was before it.
    const callState = env.VOICE_STATE_MACHINE_ENABLED ? new CallStateMachine() : undefined;

    // WHAT SHE ALREADY KNOWS AND ALREADY ASKED (VOICE_FACT_MEMORY_ENABLED). One per call, like the
    // state machine, and shared with the tool runtime for the same reason: capture_lead_info is
    // where a name gets set, and this is what decides whether an offered name may REPLACE one the
    // lead already gave. `undefined` runs the pre-fact-memory behaviour exactly. See fact-memory.ts.
    const factMemory = env.VOICE_FACT_MEMORY_ENABLED ? new FactMemory() : undefined;

    // THE EMAIL HE IS SPELLING (VOICE_EMAIL_DICTATION_ENABLED). One per call, attached to the agent
    // below once it exists. It holds the letters across the turns the endpointer shreds his answer
    // into, and it is what NOTICES a read-back being contradicted — the refusal itself is enforced
    // by `factMemory.reject`, so with fact memory switched off this still coaches but cannot block
    // a save. See email-dictation.ts.
    const emailDictation = env.VOICE_EMAIL_DICTATION_ENABLED ? new EmailDictation() : undefined;
    const nameDictation = env.VOICE_NAME_DICTATION_ENABLED ? new NameDictation() : undefined;

    const { runtime, disabledReason, settings: tenantSettings } = await buildToolRuntime(env, {
      callId: ctx.room.name ?? 'unknown',
      callerPhone: caller.callerPhone,
      // The number the caller DIALLED — ours. Previously extracted and thrown away; it is now what
      // decides whose call this is (see resolveCallIdentity).
      calledNumber: caller.calledNumber,
      participantMetadata: participant.metadata,
      report,
      callState,
      factMemory,
    });

    // THE CALL IS NOT OURS TO ANSWER.
    //
    // Someone dialled a number that maps to no active customer. The old behaviour was to fall
    // through to `VOICE_WEBHOOK_TENANT_ID` and run a full sales call on behalf of whichever tenant
    // that env var happened to name — greeting a stranger as that company and writing a lead into
    // their data. Refusing is the whole point: play a short notice and hang up, having created
    // nothing.
    //
    // The announcement is best-effort. If the asset is missing (it is generated by
    // `scripts/generate-system-announcements.mjs`, which needs a Cartesia key) the player logs and
    // returns null — and we still hang up. The refusal must not depend on a file being present.
    if (isDidRefusal(disabledReason)) {
      // ERROR, not warn, and with the fix in the line. If this fires for a number that IS a
      // customer's, their inbound is down right now and every minute of reading logs is a minute
      // of their leads hearing a dead line.
      console.error(
        'call_refused_not_in_service',
        JSON.stringify({
          reason: disabledReason,
          calledNumber: caller.calledNumber,
          fix: `node scripts/provision-number.mjs --number ${caller.calledNumber ?? '<did>'} --tenant <uuid>`,
        }),
      );
      await playRecordingNotice(ctx.room, NOT_IN_SERVICE_PATH).catch(() => null);
      await ctx.room.disconnect().catch(() => undefined);
      return;
    }

    console.log(
      runtime
        ? `tools_enabled ${JSON.stringify({ tenantId: runtime.tenantId, leadId: runtime.leadId })}`
        : `tools_disabled reason=${disabledReason}`,
    );

    // Task 0 for calls the dispatcher didn't create a row for — inbound SIP phone calls (no dialer /
    // web-call route), plus a fallback if an outbound/web-call insert failed. The agent opens the
    // conversation itself so phone calls appear in the dashboard list, not only simulator/outbound.
    // Fire-and-forget: never delay the greeting; a failed insert just leaves the call unlisted. The
    // phone-based lead upsert converges with any later book_meeting/capture on the same lead, so the
    // race with an early tool call is harmless. conversationId is only read at shutdown, by which
    // time this has long since resolved.
    if (runtime && !runtime.conversationId) {
      void ensureAgentSideConversation(runtime.db, {
        tenantId: runtime.tenantId,
        leadId: runtime.leadId,
        callerPhone: runtime.callerPhone,
        roomName: runtime.callId,
      })
        .then((rec) => {
          if (rec) {
            runtime.leadId = rec.leadId;
            runtime.conversationId = rec.conversationId;
            console.log('agent_conversation_created', JSON.stringify({ conversationId: rec.conversationId }));
          }
        })
        .catch((err) => {
          console.error('agent_conversation_create_failed', err instanceof Error ? err.message : String(err));
        });
    }

    // Per-turn latency baseline. LiveKit already measures each stage; we just surface it.
    // Wall-clock timestamps are useless here — the gap between turns is the human thinking,
    // not the pipeline working. These are the numbers the Phase 2 budget is written against:
    //   endOfUtteranceDelayMs — how long we waited before deciding the caller had finished
    //   ttftMs                — LLM time to first token
    //   ttfbMs                — TTS time to first audio byte
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as Record<string, unknown>;
      const stage = String(m.type ?? 'unknown');
      // `transcriptionDelayMs` is how long the turn waited for SONIOX's final transcript after
      // Silero already said the caller stopped. The two run on tee'd copies of the same audio
      // (audio_recognition.js: `primaryInputStream.tee()`) and the turn commits on the LATER of
      // them — so with the VAD timer at 100ms and end-of-turn measuring ~600ms, this is the number
      // that says whether the missing 500ms is Soniox finalising. The SDK has always emitted it;
      // we simply never read it.
      const timings = (
        ['endOfUtteranceDelayMs', 'transcriptionDelayMs', 'ttftMs', 'ttfbMs', 'durationMs'] as const
      )
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

      // `cancelled` is the SDK's own verdict on whether this inference was paid for and thrown
      // away (`LLMMetrics.cancelled` / `TTSMetrics.cancelled`, both set from the generation's abort
      // signal). It is the direct measurement of preemptive waste — and for TTS it arrives with
      // `charactersCount`, i.e. the actual Cartesia bill for audio nobody heard. Fed in before the
      // `timings.length` gate below, which drops events that happen to carry no timing.
      preemptive.noteMetrics(m);

      if (timings.length > 0) {
        ctx.proc.userData.lastMetricsAt = Date.now();
        report.recordMetric(stage, m);
        console.log(`latency ${stage} ${timings.join(' ')}`);
      }
    });

    // PERCEIVED DEAD AIR — the caller stopped talking; how long until they heard anything back.
    //
    // The stage metrics above cannot answer that question. They measure our pipeline one piece at
    // a time and their sum (`worstCaseMs`) assumes nothing overlaps — which is false precisely
    // when things go WELL, because preemptive generation's whole job is to run the LLM and TTS
    // inside the end-of-turn wait. On the 2026-08-16 call the stage maths said 1466ms and the
    // caller sat through a median of 2535ms. We optimised against an instrument that could not
    // see the thing we were optimising.
    //
    // Session state transitions can. 'speaking' → not-speaking on the user side is the caller
    // stopping; 'speaking' on the agent side is audio actually going out. The gap between them is
    // the silence, whatever caused it — including the causes we have no metric for (a discarded
    // draft, a fragmented turn, queueing).
    //
    // Deliberately NOT inside the `if (callState)` block below: this is instrumentation, and it
    // must keep working when the state machine kill-switch is off.
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') report.noteUserStartedSpeaking();
      else if (ev.oldState === 'speaking') {
        report.noteUserStoppedSpeaking();
        // MAKE SILERO AND SONIOX TALK TO EACH OTHER. They run on tee'd copies of the same audio
        // and never exchange a word, yet a turn needs both: the VAD's stop time AND the final
        // transcript. So every turn waits on Soniox re-deriving, from the audio alone, the thing
        // Silero just decided. Measured on 17 turns (2026-08-18): end-of-turn median 565ms, of
        // which Silero's share was 1ms. On the turns whose transcript happened to be ready
        // already, end-of-turn was 128ms — the VAD timer and nothing else.
        //
        // Soniox's own docs recommend exactly this: wait ~200ms of silence after speech ends,
        // then finalise. VOICE_VAD_MIN_SILENCE_MS is what defines "after speech ends" here.
        finalizeTranscriptNow(components.stt);
      }
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking') report.noteAgentStartedSpeaking();
    });

    // ── MUTE WATCHDOG ─────────────────────────────────────────────────────────────────────────
    // Deliberate silence needs a way back out, and it did not have one.
    //
    // When the caller asks her to hold, the model answers with the NO_RESPONSE_NEEDED control
    // token and the guard strips it to an empty reply. That is correct — and terminal. Nothing
    // downstream can tell "quiet on purpose" from "dead", so she stays mute until the CALLER
    // rescues the call. On 2026-08-16 he waited twenty seconds, asked "הלו, מישהו שם?", and told
    // her "נעלמת לי ממש". A hold that never ends is indistinguishable from a dropped call.
    //
    // The existing silence reflex does not cover this: it keys off the user going 'away', which
    // needs the user's own turn to have ended, and the turn that provoked the silence had not.
    // This one keys off HER saying nothing, which is the actual condition.
    let muteTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelMuteWatchdog = (): void => {
      if (muteTimer) {
        clearTimeout(muteTimer);
        muteTimer = null;
      }
    };
    // Armed below, once the agent exists (it is constructed further down this function).
    const armMuteWatchdog = (): void => {
      if (env.VOICE_HOLD_CHECKBACK_MS === 0) return;
      cancelMuteWatchdog();
      muteTimer = setTimeout(() => {
        muteTimer = null;
        // Anything that made noise in the meantime already ended the silence.
        if (session.agentState === 'speaking' || session.agentState === 'thinking') return;
        if (callState?.isTerminal()) return;
        // Attributed in the report the same way the silence reflex is — see `endedBy` in
        // call-report.ts. A gap this watchdog ended must not read as an unexplained stall either.
        report.recordMetric('mute_checkback', { durationMs: env.VOICE_HOLD_CHECKBACK_MS });
        console.log('reflex_mute_checkback', JSON.stringify({ afterMs: env.VOICE_HOLD_CHECKBACK_MS }));
        session.say(HOLD_CHECKBACK_HE, { allowInterruptions: true });
      }, env.VOICE_HOLD_CHECKBACK_MS);
      muteTimer.unref?.();
    };
    // The caller speaking, or her speaking, is the silence ending — whichever comes first.
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') cancelMuteWatchdog();
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking') cancelMuteWatchdog();
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

      // Hand the LiveKit logger back its own methods. AFTER the report is serialized below would
      // be equally correct (the counters are already tallied), but a wrapper left installed across
      // a worker's lifetime would stack one layer per call in a process that serves many.
      preemptive.uninstall();

      // Settle the AI-disclosure verdict from what was actually SAID (deterministic transcript
      // scan): 'during_call' | 'at_end' | 'missed'. A 'missed' means the goodbye instruction was
      // ignored — that's an audit finding, not a formality.
      report.resolveAiDisclosure(hasAiDisclosure);

      // Whether the discovery gate ever opened. Read next to gateAViolations: violations with a
      // shut gate is the defect the gate exists to catch; zero violations with a shut gate is a
      // call she held the line on and probably one that never got far enough to pitch.
      if (agent.salesGate) report.recordGateAOpen(agent.salesGate.isOpen);

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
          const [inserted] = await runtime.db.insert(callLearnings).values({
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
              // The advisory state machine's record: final stage, the stage timeline, the reflex
              // situations that fired, and the working memory ("what we knew by the end"). Merge-safe
              // (these keys are agent-written; the GPT analysis never emits them) and invisible to the
              // CRM sync (which reads only end_reason + summary). Absent when the layer is disabled.
              ...(callState?.serialize() ?? {}),
            },
            // The full CallReport verbatim (latency medians, per-turn metrics, transcript, usage) in
            // its own column so every call's stats are queryable from the DB — not just whenever an
            // `lk agent logs` capture happened to be running. Isolated from `analysis` so the
            // GPT-analysis worker can't overwrite it.
            callReport: json,
            durationSecs: json.durationSec,
            status: 'pending',
            label: 'livekit',
          }).returning({ id: callLearnings.id });
          console.log('call_learnings_written', JSON.stringify({ tenantId: runtime.tenantId, learningId: inserted?.id }));

          // Hand the transcript to the call-analysis worker: GPT sales analysis (summary, learnings)
          // layered over the agent's own instrumentation, and the Task-0 conversation finalized to
          // 'ended' + summarized. Best-effort — a dead queue leaves the row 'pending' (recoverable),
          // never crashes teardown. The transcript is already safely persisted above.
          if (inserted?.id && runtime.callAnalysisQueue) {
            try {
              await enqueueLiveKitCallAnalysis(runtime.callAnalysisQueue, {
                tenantId: runtime.tenantId,
                learningId: inserted.id,
                ...(runtime.conversationId ? { conversationId: runtime.conversationId } : {}),
              });
              console.log('call_analysis_enqueued', JSON.stringify({ learningId: inserted.id }));
            } catch (err) {
              console.error('call_analysis_enqueue_failed', err instanceof Error ? err.message : String(err));
            }
          }
        } catch (err) {
          console.error('call_learnings_write_failed', err instanceof Error ? err.message : String(err));
        }

        // PHASE 5a — what this call COST, into the usage ledger.
        //
        // This is where `SessionUsageUpdated` finally lands. It has been collected into
        // `report.recordUsage()` since Phase 4 and, until now, only ever `console.log`ged — so the
        // one number that says whether the pricing model survives has been thrown away at the end
        // of every call.
        //
        // Zero billable units: calls are never an invoice line (leads are). This is the margin
        // signal, and it is the only way `docs/gtm/pricing-model.md`'s "real cost/min has never
        // been measured" ⚠️ ever gets closed.
        //
        // Its OWN try/catch, separate from the call_learnings block above, because the two must not
        // be able to lose each other: a metering failure must not cost us the transcript, and a
        // transcript failure must not cost us the cost. `dedupeKey` is the room name, so a worker
        // restarted mid-teardown cannot double-count.
        try {
          const json = report.toJson();
          await meterCall(runtime.db, {
            tenantId: runtime.tenantId,
            roomName: ctx.room.name ?? 'unknown',
            usage: json.usage,
            durationSec: json.durationSec,
          });
        } catch (err) {
          console.error('usage_meter_call_failed', err instanceof Error ? err.message : String(err));
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
      //
      //    P1-2 (2026-08-30): the SDK stamps `metrics.startedSpeakingAt` / `stoppedSpeakingAt` on
      //    the committed message — the only clock in the system that says when her voice actually
      //    started and stopped. The event itself fires when the message COMMITS, which is after
      //    playout, so recording only `Date.now()` here is what made two consecutive transcript
      //    timestamps look like a 6-second gap when most of that was her talking. Free to collect;
      //    it is already on the object.
      const item = ev.item as {
        role?: string;
        textContent?: string;
        metrics?: { startedSpeakingAt?: number; stoppedSpeakingAt?: number };
      };
      if (item?.role && item?.textContent) {
        report.recordTranscript(item.role, item.textContent, item.metrics);
      }

      // 1b. Advance the conversation state machine on committed turns (opening→discovery→…).
      //     No-op when the advisory layer is disabled (callState undefined).
      if (item?.role === 'user') {
        callState?.onUserTurn();
        // A register belongs to one answer. A hesitation declared two turns ago is not a hesitation
        // now, and carrying it forward would leave her permanently slow after one uncertain reply.
        agent.clearDeclaredMode();
        // The turn her NEXT reply is answering. Read in llmNode to decide whether the opener is a
        // receipt, a nod, or a comprehension claim — see dictation.ts and engagement.ts.
        agent.lastUserUtterance = item.textContent ?? null;
        // How much is he giving her? Drives which discovery questions she is allowed to ask.
        agent.engagementTracker?.observeCaller(item.textContent);
        // WHEN he wants it. Recorded only once the call is in the scheduling frame, so an
        // incidental "מחר" earlier in the conversation is not read as a booking preference.
        if (item.textContent) agent.slotMemory?.observeCallerUtterance(item.textContent);
        // EMAIL DICTATION: stitch the letters he is spelling, and catch the moment he says a value
        // she read back is wrong. The rejection is handed straight to fact memory, which is where
        // capture_lead_info will look before it saves anything (fact-memory.ts `reject`).
        if (item.textContent && agent.emailDictation) {
          const wrong = agent.emailDictation.observeCallerUtterance(item.textContent);
          if (wrong) {
            agent.factMemory?.reject('email', wrong);
            // The VALUE is the lead's address and never goes to stdout — its shape is all anyone
            // debugging this needs, and an agent log is not a place for a customer's email.
            console.log(
              'email_rejected',
              JSON.stringify({ chars: wrong.length, domain: wrong.split('@')[1] ?? null }),
            );
          }
        }
        // NAME DICTATION: the same two jobs for a Hebrew name — stitch the letters he is spelling
        // across the turns the endpointer cuts it into, and catch the moment he says the name she
        // read back is wrong. See name-dictation.ts.
        if (item.textContent && agent.nameDictation) {
          const wrongName = agent.nameDictation.observeCallerUtterance(item.textContent);
          if (wrongName) {
            agent.factMemory?.reject('name', wrongName);
            // The NAME is the lead's own and never goes to stdout, same rule as the email above.
            console.log('name_rejected', JSON.stringify({ chars: wrongName.length }));
          }
        }
      }
      else if (item?.role === 'assistant') {
        callState?.onAgentTurn();
        // Anti-repetition ledger: fold her committed reply in, then (below, after the trim)
        // refresh the per-turn "do not reuse these phrasings" note. The ledger itself dedupes
        // the preemptive-draft echo this event delivers.
        if (env.VOICE_PHRASE_LEDGER_ENABLED && item.textContent) {
          agent.phraseLedger.observe(item.textContent);
        }
        // Call memory: count the QUESTIONS in what she just said. Fed from the committed item
        // rather than from the model's intent, so the count is of asks the caller actually heard —
        // which is what he was reacting to when he said "we already covered this".
        if (item.textContent) agent.factMemory?.observeAgentUtterance(item.textContent);
        // Slot memory counts HER timing asks from the same source and for the same reason: the
        // number that matters is how many times the caller heard the question, not how many times
        // the model meant to ask it. See slot-memory.ts.
        if (item.textContent) agent.slotMemory?.observeAgentUtterance(item.textContent);
        // What she just READ BACK, so his next "לא נכון" has a value to attach to. Same source and
        // the same de-dupe as the line above — see email-dictation.ts.
        if (item.textContent) agent.emailDictation?.observeAgentUtterance(item.textContent);
        if (item.textContent) agent.nameDictation?.observeAgentUtterance(item.textContent);
        // Spoken register: is she actually reaching for an everyday word, or only being told to?
        if (item.textContent) agent.registerTracker?.observe(item.textContent);
        // GATE A, THE HALF THAT WAS MISSING. `observeAgentSpeech` was written on 2026-09-01 with
        // the gate and never called, so the gate shipped to production with no way to tell whether
        // it held — the exact failure its own header warns about. Fed from the COMMITTED item, as
        // the method's doc requires: a sentence the preemptive path generated and threw away was
        // never heard by anybody, and counting it would inflate the metric in the one direction
        // that makes it useless.
        if (item.textContent && agent.salesGate) {
          const before = agent.salesGate.violations;
          agent.salesGate.observeAgentSpeech(item.textContent);
          if (agent.salesGate.violations > before) agent.onGateAViolation?.(item.textContent);
        }
        // Closes the caller's turn for the engagement window: everything he says before her NEXT
        // reply is one turn, however many items Soniox splits it into. See engagement.ts.
        agent.engagementTracker?.observeAgentTurn();
      }

      // 1c. The caller stating their gender outright ("אני אישה", "אפשר בלשון זכר") switches the
      //     pronunciation table IMMEDIATELY — before the LLM's next reply, not one reply late.
      //     On the 2026-08-26 test call the correction was heard a full turn after it was asked
      //     for, because only her own conjugation was being watched.
      if (item?.role === 'user' && item.textContent) {
        const flipped = agent.genderTracker.observeUser(item.textContent);
        if (flipped) {
          console.log(
            `speech_guard ${JSON.stringify({ note: `address gender -> ${flipped === 'f' ? 'feminine' : 'masculine'} (caller self-identified)` })}`,
          );
        }
      }

      // 2. Trim the history — HERE, between turns, and never inside onUserTurnCompleted, where it
      //    invalidated LiveKit's preemptive draft on every single turn. See trimHistory().
      //    The coach note rides the SAME promise chain, never concurrently: both do a
      //    copy→mutate→updateChatCtx, and two racing copies would silently drop one change.
      const trimmed = trimHistory(agent, env.VOICE_MAX_HISTORY_ITEMS);
      if (
        item?.role === 'assistant' &&
        (env.VOICE_PHRASE_LEDGER_ENABLED ||
          agent.factMemory ||
          agent.registerTracker ||
          agent.engagementTracker ||
          agent.slotMemory ||
          agent.emailDictation)
      ) {
        void trimmed.then(() => injectCoachNote(agent));
      }

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
    // Per-tenant grounding: when the gate opened we have the tenant's settings in hand, so Keren
    // speaks from the business's OWN configured facts (product, pricing, objections, tone) instead
    // of the hard-coded ClickScales copy. No profile → readBusinessProfile returns null → the
    // prompt is byte-for-byte the previous one. (No runtime = gate closed = no settings loaded.)
    const businessProfile = runtime ? readBusinessProfile(runtime.settings) : null;

    // WHO SHE IS on this call. Same source as the prompt's Role section, the greeting and the
    // voicemail message, so a tenant cannot end up correctly named in one and stale in another.
    //
    // The tenant's settings arrive on call metadata (sanitizeSettingsForAgent ships agent_persona),
    // so this is a local read, not a cross-region DB hop at pickup.
    //
    // NOT `runtime.settings` — `tenantSettings`, which buildToolRuntime returns even when the tool
    // gate is CLOSED. Reading it off the runtime meant a tenant who had simply not enabled booking
    // got ClickScales' name, company, FAQ and voicemail message. Identity does not depend on tools.
    //
    // Genuinely absent settings — a console call, or an unidentifiable tenant — resolve to
    // DEFAULT_PERSONA, which renders the prompt byte-for-byte as it was before this file existed
    // (system-prompt.persona.test.ts).
    const persona = readAgentPersona(tenantSettings);
    const agent = new ClickScalesAgent(
      {
        instructions: buildSystemPrompt({
          toolsEnabled: runtime !== null,
          businessProfile,
          objectionHandling: env.VOICE_STATE_MACHINE_ENABLED,
          persona,
          // Must track the same flag the ack itself reads. If the prompt forbids her opener while
          // no acknowledgement is being spoken, she starts every reply cold.
          instantAck: env.VOICE_INSTANT_ACK,
          spokenRegister: env.VOICE_SPOKEN_REGISTER_ENABLED,
          // The prompt half of the call memory. Same flag as the code half, so the instructions and
          // the enforcement can never describe different rules.
          factMemory: env.VOICE_FACT_MEMORY_ENABLED,
          negationSafety: env.VOICE_NEGATION_SAFETY,
          noPreamble: env.VOICE_NO_PREAMBLE_ENABLED,
          // The three tests Step 3 must pass before it may disqualify anybody. Prompt-only —
          // there is no code path that disqualifies, which is why the 79-second sign-off on the
          // 2026-08-31 16:51 call had nothing to intercept it. See DISQUALIFY_GATE.
          lateDisqualify: env.VOICE_LATE_DISQUALIFY_ENABLED,
          // The sales model — the seven-stage flow, Gate A, the five mandatory questions, pain
          // deepening, the interest check and the summary close. Same flag as its code half
          // (sales-gate.ts), so a note about a rule she was never given is impossible.
          salesModel: env.VOICE_SALES_MODEL_ENABLED,
          // The three delivery registers, and the marker she declares them with. Same flag as the
          // guard stage that strips that marker — a prompt asking for `[[H]]` while the stripper is
          // off would have Cartesia read double brackets at a lead. See voice-mode.ts.
          voiceModes: env.VOICE_VOICE_MODES_ENABLED,
          // Real, at last. Renders ONE branch of Step 1 — she no longer greets an inbound caller
          // as though she had rung him.
          outbound: isOutboundCall,
          // Permission to let the email go and keep the meeting. Same flag as book_meeting's
          // nullable email argument, so she is never told to make a call the tool would refuse.
          bookWithoutEmail: env.VOICE_BOOK_WITHOUT_EMAIL,
          // Where a lead may WhatsApp his email address when the phone line will not carry it
          // (Koren, round-8 card e5). Empty unless a WhatsApp sender is actually configured, and
          // empty means she makes no such offer — she must never name a channel that will not
          // reach us. An INBOUND message needs no template and no consent: it stamps the lead's
          // 24h window itself (whatsapp.routes.ts -> touchWhatsappWindow), which is why this
          // direction works where our outbound confirmation still does not.
          whatsappHandbackNumber: env.VOICE_EMAIL_WHATSAPP_HANDBACK_ENABLED
            ? (env.TWILIO_WHATSAPP_NUMBER ?? '')
            : '',
          // The prompt lists the words the caller will actually hear, so the bank and its
          // description can never disagree about what she has already said.
          acknowledgements: env.VOICE_ACK_LEDGER_ENABLED
            ? ACKNOWLEDGEMENTS_HE_WIDE
            : ACKNOWLEDGEMENTS_HE,
        }),
        ...(runtime ? { tools: buildAgentTools(runtime) } : {}),
        // A per-tenant VOICE, and ONLY when the tenant actually configured one.
        //
        // The default tenant therefore constructs nothing extra and runs the identical code path
        // it runs today — which matters more here than anywhere else in this change, because the
        // TTS is the component whose latency has been tuned by ear over months of real calls.
        // A custom-voice tenant pays one object construction (no network) plus a cold socket that
        // the recording-notice pre-roll already covers.
        ...(persona.tts ? { tts: buildTTS(env, persona.tts) } : {}),
      },
      runtime,
      env.VOICE_INSTANT_ACK,
      factMemory,
    );
    // What the registers multiply. Read through resolveVoiceProfile rather than off env, so a
    // tenant tuned to their own rate keeps it and simply slows down RELATIVE to it.
    agent.baseSpeed = resolveBaseSpeed(env, persona.tts);
    if (persona.tts) {
      // Otherwise the CallReport names the PLATFORM default engine for a call that used a
      // different one — the same mistake the ttsModel comment above was written to prevent, just
      // arriving from the tenant rather than from env.
      report.updateConfig({ ttsModel: describeTtsModel(env, persona.tts) });
    }
    console.log(
      'persona_resolved',
      JSON.stringify({
        agentName: persona.agentName,
        company: persona.companyName,
        gender: persona.agentGender,
        isDefault: isDefaultPersona(persona),
        customVoice: persona.tts !== null,
      }),
    );

    // Now that she exists, give her deliberate silence a way out. See the MUTE WATCHDOG above.
    agent.onSilentReply = armMuteWatchdog;

    // …and the spelling memory for the email. See email-dictation.ts.
    agent.emailDictation = emailDictation;

    // …and the same for a Hebrew name spelled letter by letter. See name-dictation.ts.
    agent.nameDictation = nameDictation;

    // A tool call that came out on the wrong channel and was stopped before it was spoken. Counted
    // on the call so it is a number rather than something you have to spot in a transcript.
    agent.onSpeechLeak = (reasons) => report.recordToolCallLeak(reasons);

    // A claim that the meeting was already booked, caught before it was spoken. Counted for the
    // same reason a leak is: on the 2026-08-31 16:51 call this was the one defect that reached a
    // person AFTER the call ended, and a number is the only way anybody sees it did not recur.
    agent.onFalseBookingClaim = (spoken) => report.recordFalseBookingClaim(spoken);

    // The second question in one reply, and a sentence describing her own configuration. Both
    // counted for the same reason as the two above: the caller hears a fluent turn either way, so
    // without a number nobody would ever know the guard had fired. See the 19:54 call, conclusions
    // 6 and 8.
    agent.onSecondQuestionDropped = () => report.recordSecondQuestionDropped();
    agent.onSelfNarrationDropped = () => report.recordSelfNarrationDropped();
    agent.onRepeatedSentenceDropped = () => report.recordRepeatedSentenceDropped();
    agent.onStopAnnouncementRewritten = () => report.recordStopAnnouncementRewritten();
    agent.onProductClaimSlangRewritten = () => report.recordProductClaimSlangRewritten();

    // Gate A does not block anything — a guard that silenced a product sentence would leave the
    // caller listening to a gap. So this counter IS the enforcement's only evidence, and until
    // 2026-09-02 it did not exist: the gate ran a day in production unmeasured.
    agent.onGateAViolation = () => report.recordGateAViolation();

    // The register each step was spoken in, and the marker that should never have got this far.
    // `modeMarkerLeaks` must read zero: non-zero does not mean a caller heard brackets, it means
    // only the last net stopped them, which is one failure away from audible.
    agent.onVoiceMode = (mode) => report.recordVoiceMode(mode);
    agent.onModeMarkerLeak = () => report.recordModeMarkerLeak();

    // The model's REAL first-token time. The SDK's own ttft now measures our acknowledgement, so
    // without this the ~840ms GPT actually takes would simply disappear from the report and every
    // future reading would flatter the change that hid it.
    agent.onModelFirstToken = (ms) => {
      report.recordMetric('model_ttft', { durationMs: ms });
      console.log(`latency model_ttft ${ms}ms`);
    };

    // The caller's clock, readable from inside ttsNode. See ClickScalesAgent.msSinceUserStopped.
    agent.msSinceUserStopped = () => report.msSinceUserStopped();

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
    //
    // ARMING IS NOT SPENDING (2026-08-29). The budget lives in `agent.fillerLedger` and is charged
    // by whoever actually SPEAKS the word — ttsNode's `onUsed`, or the turn opener in llmNode. An
    // armed filler that never reached the caller (the reply turned out to be a tool call and
    // carried no words) costs nothing, because a call that spent its three fillers on silence
    // would then have to sit through every later pause with no hesitation left.
    let fillerTimer: ReturnType<typeof setTimeout> | null = null;

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

      fillerTimer = setTimeout(() => {
        fillerTimer = null;
        const filler = agent.fillerLedger.offer();
        if (!filler) return; // ceiling reached or still inside the cooldown
        // ARMED, not spoken. ttsNode puts it at the front of the reply that is still being written
        // — and drops it if that reply turns out to have no words of its own.
        agent.pendingFiller = filler;
        console.log(
          `thinking_filler ${JSON.stringify({
            filler,
            n: agent.fillerLedger.used.length,
            max: MAX_FILLERS_PER_CALL,
            armed: true,
          })}`,
        );
      }, env.VOICE_THINKING_FILLER_MS);
    });

    // ── Situational reflexes ──────────────────────────────────────────────────────────────────
    // The state machine reacts to events the LLM never sees (it only ever gets committed turns).
    // Every reaction is a FIXED line via session.say() — no prompt/chatCtx mutation, so preemptive
    // generation is untouched. Silence + barge-in run on every call; voicemail is outbound-only and
    // flag-gated. All three reference the `callState` const and the `runtime`/`session` in scope.
    // Same value the prompt was built from, read once at the top of the call. Two parses of the
    // same metadata is two chances to disagree about which call this is.
    const isOutbound = isOutboundCall;

    // The whole reflex layer is gated by the kill-switch: when callState is undefined
    // (VOICE_STATE_MACHINE_ENABLED=false) none of these handlers are subscribed, and Keren behaves
    // exactly as she did before the state machine.
    if (callState) {
    // SILENCE — the caller went quiet. Strike 1 is a stage-scoped check-in; strike 2 reassures and
    // holds the line; past the cap she waits quietly. Gated so a nudge never lands on top of an
    // in-flight draft (which would clip her).
    //
    // ── THE FIFTEEN-SECOND DEAD LINE (2026-08-31), and how long it had been there ─────────────
    //
    // This handler fires off the SDK's `user_state_changed -> 'away'`, and that event is driven by
    // `AgentSession`'s `userAwayTimeout` — DEFAULT 15 SECONDS, which nobody here had ever set. So
    // the answer to "how long may a caller hear absolutely nothing?" was a framework default. On
    // the 2026-08-31 production call it was collected twice, at 117s and at 301s: gaps of 15294ms
    // and 15363ms in which NOTHING ran — no STT final, no end-of-turn, no LLM request, no
    // preemptive draft, no tool. The only pipeline event inside either window was the TTS first
    // byte of the nudge itself (236ms / 275ms), and 15000 + that is the gap to the millisecond.
    //
    // The bound is now ours: VOICE_SILENCE_AWAY_MS (agent.config.ts sets userAwayTimeout from it).
    //
    // ── AND IT ONLY EVER FIRED ONCE PER SILENCE ──────────────────────────────────────────────
    //
    // The SDK re-arms its away timer only when the user is 'listening' (agent_session.js
    // `_updateUserState`), and after this handler runs the user is 'away' — so a caller who stayed
    // silent through the nudge was never checked on again, however long he sat there. Strike 2 was
    // unreachable inside a single silence. `armSilenceRecheck` below closes that: the same decision
    // function, the same cap (`decideSilenceAction` returns null past MAX_SILENCE_NUDGES, so a call
    // can never be nudged more than twice), just re-armed after her line finishes.
    //
    // ── AND IT FIRED INTO A MAN WHO WAS THINKING (2026-08-31 13:52) ──────────────────────────
    //
    // Twice inside the first minute of a 3.5-minute call, 7287ms at 27s and 7345ms at 46s, both
    // immediately after she had asked an open discovery question. `quietSince` is the second half
    // of the fix: the SDK's `away` event still fires on VOICE_SILENCE_AWAY_MS, but she does not
    // SPEAK until the line has actually been quiet for VOICE_SILENCE_NUDGE_MS. See
    // silenceNudgeWaitMs() for the measurement behind the number, including the reason the more
    // obvious "suppress while a turn is in flight" rule would not have caught either of these.
    //
    // Measured from the last moment EITHER party was making a sound, not from the away event — the
    // away timer starts when her audio stops, so the two agree on a clean turn and differ exactly
    // where it matters: a re-arm part-way through a silence must not restart the clock.
    let quietSince: number | null = null;
    const markTalking = (): void => {
      quietSince = null;
    };
    const markQuiet = (): void => {
      if (quietSince === null) quietSince = Date.now();
    };
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') markTalking();
      else markQuiet();
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking') markTalking();
      else markQuiet();
    });

    const nudgeOnSilence = (waitedMs: number): void => {
      if (callState.isTerminal()) return;
      if (session.agentState === 'speaking' || session.agentState === 'thinking') return;
      // AND NOT WHILE HE IS TALKING. This guard checked only whether SHE was busy, so on
      // 2026-08-16 she cut across Koren mid-sentence with "רגע, אתה עוד על הקו?" — asking whether
      // he was still there while he was in the middle of answering her. A nudge is for silence;
      // if there is speech on the line there is nothing to nudge.
      if (session.userState === 'speaking') return;
      // AND NOT BEFORE HE HAS HAD TIME TO THINK. The strike is deliberately NOT consumed here —
      // this is a re-arm, not a nudge, so a caller who eventually speaks costs the call nothing.
      const stillToWait = silenceNudgeWaitMs(
        quietSince === null ? 0 : Date.now() - quietSince,
        env.VOICE_SILENCE_NUDGE_MS,
      );
      if (stillToWait > 0) {
        armSilenceRecheck(stillToWait);
        return;
      }
      const action = decideSilenceAction(callState.onSilenceStrike(), callState.stage);
      // Past the nudge cap: hold the line quietly and keep waiting — never hang up on silence.
      if (!action) return;
      // ATTRIBUTION. Without this the silence lands in the report as an `agentGap` with `tools: []`
      // and `toolMs: 0` — fifteen seconds explained by nothing, which reads exactly like a hung LLM
      // and is not one. `call-report.ts` pairs this stage with the gap it ended (`endedBy`).
      report.recordMetric('silence_reflex', { durationMs: waitedMs });
      console.log(
        'reflex_silence',
        JSON.stringify({
          strike: callState.silenceStrikes,
          stage: callState.stage,
          waitedMs,
          teardown: action.teardown,
        }),
      );
      const handle = session.say(action.say, { allowInterruptions: true });
      // Silence never tears down (a pause is not a dead call); the branch stays as a guard in case a
      // future reflex reuses this action shape.
      if (action.teardown) {
        callState.markTerminal();
        if (runtime && action.endReason) runtime.endReason = action.endReason;
        runEndCallTeardown(session, handle);
        return;
      }
      armSilenceRecheck();
    };

    // The re-arm. Cancelled by either party making a sound, exactly like the mute watchdog, so it
    // can only ever fire into a silence that is still going on.
    let silenceRecheckTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelSilenceRecheck = (): void => {
      if (silenceRecheckTimer) {
        clearTimeout(silenceRecheckTimer);
        silenceRecheckTimer = null;
      }
    };
    // `afterMs` defaults to the away timeout (the original behaviour: re-check on the same clock),
    // and is passed explicitly when `nudgeOnSilence` decided the caller has not yet had his think
    // time — then it is exactly the remainder, so the nudge lands at VOICE_SILENCE_NUDGE_MS and not
    // one interval later.
    function armSilenceRecheck(afterMs: number = env.VOICE_SILENCE_AWAY_MS): void {
      if (env.VOICE_SILENCE_AWAY_MS === 0) return;
      cancelSilenceRecheck();
      silenceRecheckTimer = setTimeout(() => {
        silenceRecheckTimer = null;
        // She may still be delivering the previous nudge; try again after it, rather than dropping
        // the re-arm on the floor.
        if (session.agentState === 'speaking' || session.agentState === 'thinking') {
          armSilenceRecheck();
          return;
        }
        nudgeOnSilence(env.VOICE_SILENCE_AWAY_MS);
      }, afterMs);
      silenceRecheckTimer.unref?.();
    }

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') cancelSilenceRecheck();
      if (ev.newState !== 'away') return;
      nudgeOnSilence(env.VOICE_SILENCE_AWAY_MS);
    });

    // BARGE-IN — the caller talked over her. The SDK already yields; we only record it (analytics).
    session.on(voice.AgentSessionEventTypes.OverlappingSpeech, () => callState.noteSituation('barge_in'));
    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, (ev) => {
      if (!ev.resumed) callState.noteSituation('barge_in', 'false_interruption');
    });

    // VOICEMAIL — an answering machine picked up (outbound only, opt-in). Leave a short message and
    // hang up instead of running discovery into a beep. Wrapped so AMD can NEVER fail the call.
    if (isOutbound && env.VOICE_AMD_ENABLED) {
      try {
        const amd = new voice.AMD(session, { waitUntilFinished: true });
        void amd
          .execute()
          .then((prediction) => {
            if (!prediction.isMachine || callState.isTerminal()) return;
            callState.noteSituation('voicemail', prediction.category);
            callState.markTerminal();
            // Persona-derived: this message is left ON the lead's phone, so a wrong name here is
            // the one identity mistake that persists after the call ends.
            const action = decideVoicemailAction(prediction.category, buildVoicemailMessage(persona));
            if (runtime && action.endReason) runtime.endReason = action.endReason;
            console.log('reflex_voicemail', JSON.stringify({ category: prediction.category }));
            const handle = session.say(action.say, { allowInterruptions: false });
            runEndCallTeardown(session, handle);
          })
          .catch((err) => console.error('amd_failed', err instanceof Error ? err.message : String(err)));
      } catch (err) {
        console.error('amd_init_failed', err instanceof Error ? err.message : String(err));
      }
    }
    } // end if (callState) — advisory reflex layer

    // Hoisted out of the inputOptions literal below ONLY so the observer can inspect the exact
    // descriptor that was handed to the session — same call, same value, same moment.
    const noiseCancellation = TelephonyBackgroundVoiceCancellation();

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
        noiseCancellation,
      },
    });

    // WHAT THE PIPELINE ACTUALLY RESOLVED TO — one line, and the same object in the call report.
    //
    // AFTER start(), NOT BEFORE: the SDK merges its defaults into `sessionOptions` at construction
    // and the activity re-resolves turn detection at start (it DOWNGRADES the mode to undefined
    // when the preconditions fail, with only a warning). Read any earlier and this records the
    // request instead of the result — which is the whole failure mode it exists to end. The most
    // expensive instance: `preemptiveTts` was set as a cloud secret, `lk agent secrets` lists names
    // only, nothing logged it and no report carried it, so nobody could say whether preemptive TTS
    // was on in production. Now every call answers that by itself.
    try {
      const snapshot = describePipeline({
        env,
        // The authoritative resolved turn-detection mode lives on `AgentActivity.turnDetectionMode`,
        // which the SDK's own d.ts marks `private` — so reading it needs a cast whatever we do.
        // `SessionLike` is structural and every field optional, so a future SDK rename yields null
        // rather than a crash or, worse, a confident wrong answer.
        session: session as unknown as SessionLike,
        noiseCancellation: probeNoiseCancellation(
          'TelephonyBackgroundVoiceCancellation',
          noiseCancellation,
          true,
        ),
      });
      report.recordPipeline(snapshot);
      console.log(formatPipelineLog(snapshot));
    } catch (err) {
      // An instrument must never be the reason a caller hears nothing.
      console.error(
        'pipeline_snapshot_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    // The legal notice must FINISH before Keren opens her mouth — two voices at once is chaos,
    // and a notice she talked over is a notice that wasn't given. Its outcome is recorded either
    // way: `recording_notice_played` in call_learnings.analysis is the provable-compliance bit.
    const noticeAt = await noticePromise;
    const noticeStatus = !recordingNoticeOn ? 'disabled' : noticeAt !== null ? 'played' : 'failed';
    report.recordCompliance({
      recording_notice_played: noticeAt !== null,
      recording_notice_status: noticeStatus,
      ...(noticeAt ? { recording_notice_at: noticeAt } : {}),
    });
    console.log('recording_notice', JSON.stringify({ status: noticeStatus, at: noticeAt }));

    // Speak the greeting verbatim rather than letting the LLM improvise one: deterministic
    // wording, and no LLM round-trip before the caller hears anything.
    // allowInterruptions:false so a cough or line noise doesn't swallow the greeting.
    await session.say(buildGreeting(persona), { allowInterruptions: false }).waitForPlayout();
  },
});

/**
 * Outbound or inbound, off the participant's metadata.
 *
 * Absent, malformed, or anything that is not the literal string `outbound` means INBOUND — the
 * safe direction, because the inbound opening never claims to have interrupted anybody. A console
 * or browser session has no metadata and is treated as inbound for the same reason.
 */
export function readCallDirection(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    const meta = JSON.parse(metadata) as { direction?: string };
    return meta?.direction === 'outbound';
  } catch {
    return false;
  }
}

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

// WHICH DISPATCH POOL THIS PROCESS JOINS. `''` on the cloud (`start`) — byte-identical to the
// previous code, which passed no agentName at all and hit the SDK's `agentName = ""` default. A
// laptop (`dev`/`connect`/`console`) gets an explicit name instead, which takes it OUT of the pool
// that answers real inbound calls. Full reasoning and the empirical proof: ./testing/dev-dispatch.ts
const workerAgentName = resolveWorkerAgentName();
const localWorker = isLocalCommand();
// Not in the per-job child: it re-imports this file with no subcommand in argv, so the banner would
// read `dispatch=DEFAULT` on a laptop and look like the safety fix had failed. It registers nothing.
if (!isJobChildProcess()) {
  console.log(`worker_dispatch ${describeDispatch(workerAgentName)}`);
}

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: workerAgentName,
    // Phase 4 made the child runner's import graph heavy (googleapis + drizzle for the calendar
    // tools). Under tsx watch on Windows, cold-compiling that graph blows the default 10s
    // initialization budget and every dispatch dies with "runner initialization timed out"
    // before the agent ever joins the room. The cost is per-worker-boot, not per-call.
    initializeProcessTimeout: 60_000,
    // KEEP ONE JOB PROCESS WARM ON A LAPTOP. `dev` mode defaults to zero idle processes
    // (`Default.numIdleProcesses(production)` in the SDK), so the first call forks a cold child and
    // pays the whole tsx + googleapis + drizzle import cost before the agent can join. Measured:
    // >15s, long enough that the synthetic caller gave up before the agent arrived and reported
    // "no agent joined" on a run where the agent was merely late. Production is untouched —
    // `undefined` falls through to the SDK default, which on `start` is min(cores, 4).
    ...(localWorker ? { numIdleProcesses: 1 } : {}),
  }),
);
