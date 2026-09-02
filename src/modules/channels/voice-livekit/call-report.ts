import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShadowSttTranscript } from '../../../db/schema/call-learnings.js';
import {
  countConsecutiveOpenerRepeats,
  countRepeatedFourGrams,
  countRepeatedOpeners,
} from './phrase-ledger.js';
import type { PipelineSnapshot, PreemptiveCounters } from './pipeline-observer.js';
import { hasRegisterTouch } from './register-tracker.js';
import { isRestartOf } from './repeat-guard.js';

/**
 * A durable record of one call: what was heard, what was said, and how slow it was.
 *
 * WHY THIS EXISTS. Everything the agent knew about a call used to go to stdout and nowhere else —
 * so the only way anyone saw it was if a developer happened to be tailing the process and
 * hand-summarised it afterwards. Koren, whose calls these are, could not look at his own data.
 * That is not a logging gap, it is a product gap: the agent is an experiment right now, and an
 * experiment you cannot read the results of is not an experiment.
 *
 * Writes one JSON file per call to `call-reports/`. Read it with `npm run call:report`.
 *
 * This is the STOPGAP, and deliberately so. The real home for this is the `call_learnings` table
 * (that is what `shadow_stt_transcript` is for, and what `scripts/analyze-shadow-stt.mjs` reads),
 * but nothing writes a call_learnings row for a LiveKit call yet — that is Phase 4. The payload
 * shape here matches the DB column exactly, so when Phase 4 lands, persistence is a one-line change
 * and nothing downstream has to be rewritten.
 */
export interface TurnMetric {
  /** ms since call start. */
  atMs: number;
  /** eou | llm | tts — which stage of the pipeline reported this. */
  stage: string;
  endOfUtteranceDelayMs?: number;
  ttftMs?: number;
  ttfbMs?: number;
  durationMs?: number;
  /** LLM only: total input tokens for this turn. */
  promptTokens?: number;
  /** LLM only: how many of those came from OpenAI's prompt cache (a fraction of the price). */
  promptCachedTokens?: number;
  /** TTS only: duration of the AUDIO produced — not `durationMs`, which is synthesis wall time. */
  audioDurationMs?: number;
  /** TTS only: how many characters were synthesized. Pairs with audioDurationMs to give pace. */
  charactersCount?: number;
  /** TTS only: the SDK's verdict that this synthesis was thrown away. Excluded from pace. */
  cancelled?: boolean;
}

/** One line of the conversation, either side of it. */
export interface TranscriptLine {
  /**
   * When the line was COMMITTED, not when it was said. Kept as-is for comparability with every
   * report written before 2026-08-30, and it is the field that misled the P1-2 analysis: the SDK
   * commits an assistant message at the END of its playout (agent_activity.js, `_conversationItemAdded`
   * runs after `agentStoppedSpeakingAt`), so the interval between two of these contains the whole
   * of the second reply's SPEAKING TIME. Read `spokeAtMs`/`spokeUntilMs` for the sound.
   */
  atMs: number;
  /** 'user' = the caller, 'assistant' = the agent. */
  role: string;
  text: string;
  /**
   * When her voice STARTED and STOPPED, ms since call start, from the SDK's own per-message
   * metrics (`MetricsReport.startedSpeakingAt` / `stoppedSpeakingAt`, epoch seconds). Assistant
   * lines only, and absent when the reply produced no audio (a tool-only step with the
   * acknowledgement off, or an interrupted one).
   */
  spokeAtMs?: number;
  spokeUntilMs?: number;
}

/**
 * A silence INSIDE one reply — between two things she said with no caller turn between them.
 *
 * THE MEASUREMENT THAT DID NOT EXIST. `deadAir` closes its stopwatch on her FIRST audio of a turn
 * (`noteAgentStartedSpeaking` clears `#userStoppedAt`), so on a tool-calling turn it measures the
 * gap to the acknowledgement — ~1.5s, healthy — and then stops looking. Everything after that
 * receipt, which is where a tool round-trip and a second inference step live, was unmeasured.
 */
export interface AgentGap {
  /** ms since call start, when her previous audio stopped. */
  fromMs: number;
  /** How long the caller heard nothing, between the two. */
  gapMs: number;
  /** Tools that ran inside the gap, and what they cost — usually the reason it exists. */
  tools: Array<{ name: string; durationMs: number }>;
  /** How much of the gap the tools account for. The remainder is the next step's TTFT + TTS. */
  toolMs: number;
  /**
   * What BROKE the silence, when it was one of our own timers rather than the conversation.
   *
   * WHY THIS FIELD EXISTS. The 2026-08-31 call carried two gaps of 15294ms and 15363ms with
   * `tools: []` and `toolMs: 0` — fifteen seconds attributed to nothing at all, which reads exactly
   * like a stalled LLM and is not one. They were the SDK's `userAwayTimeout` (15s, its default,
   * never set by us) finally letting the silence reflex speak. An unattributed fifteen-second stall
   * is worse than a slow one: nobody can tell a framework default from a hung request by looking at
   * it. Absent on an ordinary gap — the caller was answering, and that is not a defect.
   */
  endedBy?: ReflexStage;
}

/**
 * The reflex timers that can end a silence on their own, as `recordMetric` stages.
 *
 * `silence_reflex` = the caller went quiet and VOICE_SILENCE_AWAY_MS expired.
 * `mute_checkback` = SHE went quiet on purpose (a hold) and VOICE_HOLD_CHECKBACK_MS expired.
 */
export const REFLEX_STAGES = ['silence_reflex', 'mute_checkback'] as const;
export type ReflexStage = (typeof REFLEX_STAGES)[number];

/**
 * One tool invocation (Phase 4): what the LLM called, how long it took, whether it worked.
 * Args are pre-redacted by `redactArgs()` — a phone number must never reach a report file.
 * The <500ms-per-tool budget from phase-4-agent-functions.md is judged against `durationMs`.
 */
export interface ToolCallLog {
  /** ms since call start. */
  atMs: number;
  name: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  args?: Record<string, unknown>;
}

/**
 * Legal-compliance facts about the call — provable, per call, from the record itself.
 * Mirrors the optional fields on `SalesCallAnalysis`; agent.ts copies this into the
 * call_learnings row at shutdown.
 */
export interface ComplianceLog {
  /** The recorded-call notice pre-roll actually played (Wiretapping Law 1979 §2). */
  recording_notice_played?: boolean;
  recording_notice_at?: string;
  /** 'disabled' (VOICE_RECORDING_NOTICE_ENABLED off) distinguishes an intentional skip from a
   * playback FAILURE — both leave played:false, but only one is a bug worth chasing. */
  recording_notice_status?: 'played' | 'disabled' | 'failed';
  /** When the caller learned they were talking to an AI. 'missed' should never happen. */
  ai_disclosure?: 'during_call' | 'at_end' | 'missed';
}

export interface CallReportJson {
  room: string;
  callerPhone: string | null;
  startedAt: string;
  durationSec: number;
  config: {
    sttProvider: string;
    sttModel: string;
    turnDetection: string;
    llmModel: string;
    ttsModel: string;
  };
  /**
   * WHAT THE PIPELINE ACTUALLY RESOLVED TO ON THIS CALL — read back off the live session after
   * `start()`, not copied from env.
   *
   * `config` above is what the agent ASKED for, stamped at the top of the call from env. That is
   * not the same thing and the difference has cost real time: `turnDetection` there says whatever
   * `VOICE_TURN_DETECTION` said, while the SDK silently downgrades the mode when its preconditions
   * fail. And `preemptiveTts` appeared in NEITHER — it was set on the cloud agent, unreadable
   * afterwards (`lk agent secrets` lists names only), unlogged, unrecorded, which left the single
   * biggest latency switch in the pipeline in an unknown state in production for weeks.
   *
   * Null on a report written before the snapshot was taken (a call that died during startup), and
   * on reports from before this field existed.
   */
  pipeline: PipelineSnapshot | null;
  summary: {
    /** Turns where the agent decided the caller had finished speaking. */
    turnsHeard: number;
    /** Speech segments the agent synthesized. */
    ttsSegments: number;
    /**
     * Times the STT declared the caller finished WHILE THE VAD STILL HEARD SPEECH — i.e. she cut
     * him off mid-sentence.
     *
     * THE NUMBER THAT CATCHES A BROKEN CALL, and the only trustworthy one. Latency cannot see this:
     * a turn chopped in half FINALISES FASTER, so a cut-off call reports a BETTER end-of-turn
     * median. We measured our best-ever 259ms in precisely the call where the agent went silent on
     * the caller three times. The instrument said we had won while he was being talked over.
     *
     * (An earlier version of this file tried to infer cut-offs from turnsHeard - ttsSegments. That
     * is NOT a valid subtraction — TTS segments include the greeting and preemptive drafts, so it
     * goes NEGATIVE on a healthy call. Do not resurrect it.)
     */
    cutOffs: number;
    /**
     * Times the agent CHOPPED ONE SENTENCE INTO SEVERAL TURNS — she decided the caller had finished
     * while he was mid-thought, and he had to keep going.
     *
     * THIS IS THE REAL CUT-OFF DETECTOR, and `cutOffs` above is nearly useless without it. That
     * counter watches for a LiveKit warning that ONLY EXISTS IN `stt` TURN-DETECTION MODE. In `vad`
     * mode — which is what we actually run — it can never fire, so it reports a serene 0 on a call
     * where the agent talked over the caller from start to finish. I reported "cut-offs: 0" on
     * exactly such a call.
     *
     * Detected instead from the transcript itself: two CALLER turns in a row, close together, with
     * no agent reply between them, means one utterance was split in half. On the call that broke
     * phone-number capture this fired repeatedly — "050." / "888-45." / "רשמת?" are one sentence
     * that the turn detector shredded.
     *
     * A booking agent that cannot receive a phone number in one breath is not a slow agent. It is a
     * broken one.
     */
    fragmentedTurns: number;
    /**
     * Times the agent spoke the same reply twice. SHOULD ALWAYS BE ZERO — and if it is not, verify
     * against the AUDIO before believing it.
     *
     * This metric exists because of a mistake, and the mistake is the point. `ConversationItemAdded`
     * fires TWICE for one reply when preemptive generation is on: once for the draft, once for the
     * confirmed message, same text. The transcript therefore showed four paragraph-length answers
     * "delivered twice". I concluded the agent was repeating itself to callers, told Koren that was
     * the root cause of everything he disliked about it, and disabled preemptive TTS.
     *
     * She had never repeated herself. He had been on the call and said so. The audio agreed: 20 TTS
     * segments against 19 transcript lines — a real double would be ~30.
     *
     * recordTranscript() now drops the draft echo, so this counts SPOKEN repeats only. If it ever
     * goes above zero, check `ttsSegments` against the number of unique replies before acting.
     * A log line is not evidence of a sound.
     *
     * WIDENED 2026-09-01. It counted only an EXACT repeat, and on the 09:29 call that made it read
     * 0 through three replies that all began with the same thirteen words. It now also counts a
     * RESTART — see `restartedReplies` below, which reports that half on its own so the two are
     * never confused. The "should always be zero" reading is unchanged; what changed is that it can
     * finally see the thing it was zero through.
     */
    duplicateReplies: number;
    /**
     * The half of `duplicateReplies` that is a RESTART — she began the same reply again after a
     * barge-in cut the first attempt off.
     *
     * 2026-09-01 09:29: three replies in seven seconds, all opening
     * "זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה", and `duplicateReplies` read 0.
     * The old test was `===` on the committed text and a restart is never byte-identical — the
     * interruption picks the stopping point and it moves every time (0.27s, 0.45s, 0.56s of audio
     * on those three), while the first attempt also carried the acknowledgement `llmNode` injects.
     *
     * The third metric in this file to stay green through the exact defect it exists to catch, and
     * broken out rather than only folded in so the two halves stay legible: a WHOLE reply said
     * twice is a different fault from a turn restarted after an interruption, and only one of them
     * has ever actually happened. See `isRestartOf` in repeat-guard.ts.
     */
    restartedReplies: number;
    /**
     * Sentences the anti-repetition guard suppressed because she had already said them.
     *
     * NOT "should always be zero" — a non-zero reading is the mechanism WORKING, and it is the only
     * number that says how often the model reaches for a sentence the caller has already heard. It
     * covers both 2026-09-01 shapes: the restarted empathy opener and the two identical booking
     * apologies six seconds apart. See VOICE_REPEAT_GUARD_ENABLED and repeat-guard.ts.
     */
    repeatedSentencesDropped: number;
    /**
     * Times she announced the call was ending without ending it, and the announcement became the
     * end-call gate's confirmation question.
     *
     * 2026-09-01 09:29: *"אם זה מה שיושב עליך, עדיף שנעצור כאן. תודה"* at 320s, and eleven seconds
     * later *"אם תרצה, אני אעצור את המכירה ואענה רק על מה שמעניין אותךָ"*. `end_call` was never
     * called and `endCallRefusals` was 0, so neither the tool nor the gate produced that pair — the
     * model wrote both halves. See STOP_ANNOUNCEMENT in speech-guard.ts.
     */
    stopAnnouncementsRewritten: number;
    /**
     * Times slang inside a claim about the product was swapped for `מעולה` (Koren's round-13 `s2`).
     *
     * A steady non-zero reading means the prompt rule is still not landing on its own — which is
     * what the 2026-09-01 calls showed (three `אחלה`s across two calls, one of them the banned
     * "זה עובד אחלה" verbatim). See PRODUCT_CLAIM_SLANG in speech-guard.ts.
     */
    productClaimSlangRewritten: number;
    /**
     * The silence INSIDE each thought the turn detector chopped in half — the measurement that has
     * to exist before `VOICE_VAD_MIN_SILENCE_MS` is touched.
     *
     * `fragmentedTurns` says HOW MANY. It has never said how long he actually paused, so every
     * discussion of raising the endpointing floor has been an argument rather than a calculation.
     * On the 2026-09-01 09:29 call the nine measurable gaps ran 385-1186ms with a median near
     * 700ms, against an `endOfTurnMedianMs` of 351 — i.e. the endpointer fired at its floor on
     * every single turn, and the floor sits below the pause a thinking caller leaves mid-thought.
     *
     * `caughtAt` is the sizing table: how many of this call's fragments each candidate threshold
     * would have held together. Read it against `deadAir.medianMs` — every millisecond added to the
     * floor is added to EVERY turn, and dead air on that call was already 1470ms against a 1000ms
     * budget. That trade is why the number was not simply raised.
     *
     * Both 2026-09-01 calls are the same instrument reading, not a contrast: the caller's median
     * turn was 4 words on BOTH, and 55%/56% of his turns were 4 words or fewer. 1 fragment in 16
     * caller turns against 11 in 60 is not evidence of a better-behaved call, it is a smaller
     * sample of the same behaviour.
     */
    fragmentation: {
      /** Fragments whose gap could be measured — a stitched STT hypothesis yields nonsense. */
      samples: number;
      medianMs: number | null;
      maxMs: number | null;
      /** Fragments a min-silence of N ms would have held together, per candidate N. */
      caughtAt: Record<string, number>;
    };
    /**
     * Distinct 4-grams the agent spoke 2+ times on this call — the "sounds like a robot" number.
     *
     * `duplicateReplies` above catches only a WHOLE reply said twice; this catches the failure
     * Koren actually hears (2026-08-27): the same phrasings recycled inside different replies.
     * The humanization plan's baseline measured up to 62 per call; the phrase ledger
     * (VOICE_PHRASE_LEDGER_ENABLED) is the enforcement and THIS is its gate — ≤2 per call on the
     * scenario suite. Computed by countRepeatedFourGrams (phrase-ledger.ts), the same function
     * the baseline backfill (scripts/repeated-phrases-baseline.mjs) uses, so the numbers compare.
     */
    repeatedPhraseCount: number;
    /**
     * The half of that number the 4-gram counter is blind to: distinct one-word OPENERS she used
     * twice or more.
     *
     * 2026-08-29 reported `repeatedPhraseCount: 0` on a call where six of eight turns opened with
     * `אהה.`, `בסדר.` or `אוקיי.`. Nothing was wrong with the 4-gram count — a repeated opener runs
     * into a different sentence each time, so it never forms a repeated 4-gram. The metric was
     * green through the exact defect it exists to catch, and a metric that does that is worse than
     * none. It is broken out here rather than only folded in, so the 4-gram figure stays comparable
     * with the humanization baseline (scripts/repeated-phrases-baseline.mjs, which measures
     * 4-grams alone). On that call this would have read 3.
     */
    repeatedOpenerCount: number;
    /**
     * How many replies opened with the same word as the reply before them.
     *
     * `repeatedOpenerCount` above cannot fall: over a long call a three-word bank must score 3
     * whatever the ordering, so it is a constant wearing a metric's clothes. This one is the
     * complaint Koren actually made on 2026-08-31 — *"not the same word every time at the start of
     * the sentence"* — and with VOICE_OPENER_NO_REPEAT_ENABLED on it should read 0. A non-zero
     * reading means either a real escape or a producer nobody wired into SpokenOpenerTracker.
     */
    consecutiveOpenerRepeats: number;
    /**
     * Times a tool-call / JSON payload was cut out of her speech before it reached the TTS.
     *
     * SHOULD ALWAYS BE ZERO, and any non-zero reading is a report about the MODEL, not about our
     * wording: it means gpt-5.4 emitted a tool call on the final channel instead of the tool
     * channel, and the guard caught it. It happened once on the 2026-08-31 13:52 production call,
     * before the guard existed, and the caller heard nineteen seconds of `to=functions.
     * capture_lead_info`, Chinese glitch tokens and his own details as raw JSON.
     *
     * Count it here so we learn how often it happens rather than finding out from a transcript.
     * `toolCallLeakReasons` says WHICH markers fired, because "a brace arrived" and "the harmony
     * routing header arrived" are different diagnoses. See toolcall-leak.ts.
     */
    toolCallLeaks: number;
    /** The distinct leak markers seen on this call, in first-seen order. Empty on a clean call. */
    toolCallLeakReasons: string[];
    /**
     * Times she claimed the meeting was already booked when it was not, and the speech guard
     * rewrote the claim before it reached the caller.
     *
     * SHOULD ALWAYS BE ZERO, and a non-zero reading is not cosmetic: on the 2026-08-31 16:51
     * production call the unguarded version of this ("קבענו לאחת עשרה", with only
     * check_calendar_availability behind it) left a real person expecting a call at 11:00 the next
     * morning that nothing in any calendar knew about. Every other defect on that call cost a lead;
     * this one cost a promise, and it is the only one that reaches somebody after the call ends.
     *
     * Counted rather than only logged because the rewrite is SILENT to everyone — the caller hears
     * a fluent sentence, and the transcript records what was spoken. Without a number nobody would
     * ever know it had happened. See FALSE_BOOKING_WIDE in speech-guard.ts.
     */
    falseBookingClaims: number;
    /**
     * Times she asked to hang up on a lead she had decided was not worth the rest of the call, and
     * the gate refused because the evidence for it was not the caller's own words.
     *
     * NOT "should always be zero" — unlike the two above, a non-zero reading here is the mechanism
     * WORKING, and it is the only number that says how often she reaches for a hang-up she cannot
     * justify. Zero across many calls means either she has stopped doing it or the gate is dead;
     * `endCallRefusalReasons` distinguishes the three ways it fires. See end-call-gate.ts.
     */
    endCallRefusals: number;
    /** Which gate condition fired, in first-seen order. Empty on a call with no refused hang-up. */
    endCallRefusalReasons: string[];
    /**
     * Sentences dropped because they were the SECOND question in one reply.
     *
     * Koren, 2026-08-31: *"שאלה כפולה באותו המשפט שווה מקור לבעיות, אנחנו צריכים להימנע מזה."* The
     * prompt has said "one question at a time" since Phase 4 and she asked two in one breath twice
     * on that call, so this is the enforcement half. A steady non-zero reading means the instruction
     * is still not landing; zero means either she obeys it or the guard is off.
     */
    secondQuestionsDropped: number;
    /**
     * Sentences dropped because she was narrating her own configuration to the caller.
     *
     * *"אני פשוט מתארת את זה בשפה יומיומית"* · *"אני מדברת ככה כי זה טבעי לי בשיחה"* — both on the
     * 19:54 call, both in answer to a caller asking why she talks the way she does. Same family as
     * a spoken tool call, one layer up. Should be zero; a non-zero reading is a prompt leak the
     * guard caught. See SELF_NARRATION in speech-guard.ts.
     */
    selfNarrationDropped: number;
    /**
     * How many times she described the product before Gate A had opened.
     *
     * The falsifiability half of the sales model, and it shipped a day late: `sales-gate.ts` was
     * deployed on 2026-09-01 with `observeAgentSpeech` defined and never called, so the gate ran
     * a full day in production with no way to tell whether it was working. Its own header warns
     * about exactly this failure — three metrics in this repo have already stayed green through
     * the defect they existed to catch.
     *
     * Non-zero means she pitched before she knew his business, his current process and his pain.
     * Zero on a call where `gateAOpen` is false means she held the line; zero on a call that never
     * had the flag on means nothing at all.
     */
    /**
     * How many inference steps ran in each delivery register.
     *
     * Read it against the transcript, not on its own: `hesitant` should cluster on the steps that
     * follow a calendar or booking tool call, and `empathetic` on the turns right after he named
     * something that costs him. All-confident on a call with tool calls means the feature is off
     * or the flag never reached the worker; all-hesitant means the model is marking everything and
     * the register has stopped meaning anything.
     */
    voiceModeTurns: Record<string, number>;
    /**
     * `[[...]]` markers that survived the narrow reader and were caught only by the wide net.
     *
     * MUST BE ZERO. Non-zero does not mean a caller heard brackets — the net is inside the guard,
     * upstream of Cartesia. It means the sentence reached the last line of defence still carrying
     * a marker, which is one failure away from audible, and this repo has already had `חח` read
     * out as the letter khet. Treat any non-zero reading as a defect, not as the guard working.
     */
    modeMarkerLeaks: number;
    gateAViolations: number;
    /** Whether all three discovery facts were established by the end of the call. */
    gateAOpen: boolean;
    /**
     * Share of her replies carrying one of the eight screened everyday words — the Spoken Register
     * quota, measured instead of assumed.
     *
     * The section asks for one every second or third reply, i.e. 33-50%. The 2026-08-29 call ran
     * at 25% (two touches in eight turns) and the person on the phone perceived none of them, so
     * treat anything under ~40% as a miss rather than a near-pass. Read it next to
     * repeatedPhraseCount: high repetition with a high touch rate means she found ONE everyday word
     * and is leaning on it, which is its own kind of robot.
     *
     * Deliberately generous — `מעולה` is also an ordinary adjective and counts either way. The bias
     * is toward over-reporting, so a low number here is a real miss.
     */
    registerTouchPct: number | null;
    /**
     * Silence INSIDE a reply — after she has already spoken once on this turn.
     *
     * P1-2, measured rather than argued. The 2026-08-30 plan read 5.7s and 6.2s "post-tool gaps"
     * off consecutive transcript timestamps and called most of it unexplained. Those timestamps are
     * COMMIT times, and the SDK commits an assistant message after its playout finishes, so the
     * interval between two of them is `silence + the second reply's entire speaking time`. This
     * measures the silence alone, from the SDK's own speaking timestamps, and reports how much of
     * it the tools account for.
     *
     * Read it WITH `deadAir`: dead air is what the caller waits before she says anything at all,
     * this is what he waits after the receipt. A healthy call has both under ~1.5s; the receipt
     * makes the first one look fine on its own.
     */
    agentGap: {
      medianMs: number | null;
      maxMs: number | null;
      samples: number;
      /** Every gap, with the tools that ran inside it — small enough to read, few per call. */
      gaps: AgentGap[];
    };
    /**
     * Share of LLM input tokens served from OpenAI's prompt cache, across the call.
     *
     * There is no switch for this — OpenAI caches automatically, on the longest common PREFIX of the
     * prompt, minimum 1024 tokens. (`cache_control` is Anthropic's parameter, not OpenAI's.) The only
     * thing we control is whether we BREAK it, and we were: a sliding history window moves the prefix
     * every turn, so the hit rate collapsed to zero on any call past ~8 exchanges — which is every
     * real sales call. Measured: 92% cached with the history intact, 0% with a 16-item window.
     *
     * A low number here on a long call means something is churning the prefix. Both the bill and the
     * prefill latency are paying for it.
     */
    promptCacheHitPct: number | null;
    /**
     * HOW LONG A CHARACTER TAKES TO SAY, across the call — the instrument for any pacing work.
     *
     * `phase-4-known-issues.md` §9 recorded that Cartesia's Hebrew output is NOT deterministic:
     * the same sentence came back at 2.9s / 4.1s / 4.5s / 7.1s across four takes, and one
     * three-second sentence arrived as 15.3s of five speech bursts. Nobody ever measured that
     * against text length, so nobody knows how wide the noise is — which means nobody can tell a
     * deliberate speed change from the engine having a bad turn.
     *
     * `spread` is max/min. It is the number to read FIRST when judging any rhythm feature: if the
     * engine's own variation on one call is 2x, a deliberate 0.90 -> 0.84 change (7%) is not
     * audible above it and no A/B on a single call can prove otherwise.
     *
     * Cancelled syntheses are excluded — a preemptive draft the caller never heard is not pace.
     * `audioDurationMs` (audio produced), never `durationMs` (synthesis wall time).
     */
    /**
     * What the per-turn coach note costs, in UTF-8 bytes.
     *
     * `growth` is last/first: the note is cumulative by design — every tracker appends to it — so
     * a call whose last note is several times its first is a call paying more for advice on every
     * turn than it did at the start. Read `max` against the system prompt's own size (~55KB) to
     * see whether it has become a material share of the prompt or is still noise.
     */
    coachNote: {
      turns: number;
      medianBytes: number | null;
      maxBytes: number | null;
      growth: number | null;
    };
    speechPace: {
      samples: number;
      medianMsPerChar: number | null;
      minMsPerChar: number | null;
      maxMsPerChar: number | null;
      spread: number | null;
    };
    endOfTurnMedianMs: number | null;
    /**
     * Time to the first chunk out of `llmNode` — WHICH IS NOT THE MODEL when the instant
     * acknowledgement is on.
     *
     * `performLLMInference` stamps its ttft on whatever comes out of `llmNode` first
     * (generation.js:381), and with VOICE_INSTANT_ACK that is our own "אוקיי." emitted before the
     * model has done anything. So this reads near zero and tells you nothing about GPT. Read
     * `modelTtftMedianMs` for that. Both are kept because their DIFFERENCE is the point: it is
     * how much of the model's thinking the acknowledgement is hiding.
     */
    llmTtftMedianMs: number | null;
    /**
     * The model's real time-to-first-token, measured in `llmNode` from reply start.
     *
     * Null when the instant acknowledgement is off — there is nothing to disentangle then, and
     * `llmTtftMedianMs` already is the model's number.
     */
    modelTtftMedianMs: number | null;
    ttsTtfbMedianMs: number | null;
    /**
     * Preemptive drafts the SDK threw away — LLM calls paid for and never heard.
     *
     * A draft survives only if `preemptive.info.newTranscript === userMessage.textContent`
     * (agent_activity.js:1711) — a STRICT string equality against the committed transcript. The
     * Soniox plugin builds an interim as `finalTokens + nonFinalTokens` but the FINAL as
     * `finalTokens` alone, so a draft started from an interim carries text Soniox has not
     * committed to yet and almost never matches: on 2026-08-16, 6 drafts, 6 discarded, 0 used.
     *
     * If this is non-zero and `deadAir` is not falling, drafting is costing money and buying
     * nothing. Both numbers have to be read together.
     *
     * AND IT IS AMBIGUOUS ON ITS OWN. Zero reads identically whether every draft survived or no
     * draft was ever made — a working feature and a dead one produce the same number. Read
     * `preemptive.generation` below, which counts starts separately from uses; this field is kept
     * unchanged so figures from earlier calls stay comparable.
     */
    draftsDiscarded: number;
    /**
     * Did preemptive generation and preemptive TTS actually fire on this call — starts, uses and
     * discards, counted separately for each.
     *
     * Null when the observer was not installed (an old report, or a call that never started a
     * session). Zeroes across the board mean the mechanism did nothing, which is a different and
     * much worse finding than "no drafts were wasted".
     */
    preemptive: PreemptiveCounters | null;
    /**
     * Sum of the three medians: the worst case, if no stage overlapped any other.
     *
     * NOT WHAT THE CALLER HEARS, and it has been read that way. It is a synthetic figure built
     * from three medians that never co-occurred on any single turn, and it is BLIND to preemptive
     * generation — the one mechanism that actually decides how long the silence is, because it
     * moves the LLM and TTS INSIDE the end-of-turn wait instead of after it. On the 2026-08-16
     * call this said 1466ms while the real median silence was 2535ms. Use `deadAir` below.
     */
    worstCaseMs: number | null;
    /**
     * PERCEIVED DEAD AIR — the caller stopped talking, and this is how long until they heard
     * anything back. Milliseconds, measured per turn.
     *
     * THE ONLY LATENCY NUMBER THAT DESCRIBES THE PRODUCT. Everything above measures a stage of
     * our pipeline; this measures the silence a human sat through, which is the thing that is
     * either under a second or is not. It is deliberately taken from session STATE transitions
     * (user stopped → agent started speaking) rather than from stage metrics, so it counts the
     * real gap including anything we do not have an instrument for: queueing, fragmentation, a
     * draft being discarded and regenerated, the agent thinking twice.
     *
     * Read `p90` before `median`. The median hides the turns that lose the call — on the call
     * that prompted this metric the median was 2.5s and the two worst turns were ~6s, and it is
     * the 6s ones the caller remembers.
     *
     * `samples` is how many turns it was measured over. A single-digit sample on a short call is
     * not evidence of anything; do not report a median over three turns as a result.
     */
    deadAir: {
      medianMs: number | null;
      p90Ms: number | null;
      minMs: number | null;
      maxMs: number | null;
      samples: number;
    };
  };
  /**
   * THE ACTUAL CONVERSATION — both sides of it.
   *
   * This was missing until someone asked for "the full transcription of the call" and it turned out
   * we had never recorded the agent's own replies, only what she heard. A record of a conversation
   * with half the conversation missing is not a record of a conversation.
   */
  transcript: TranscriptLine[];
  metrics: TurnMetric[];
  /** Every tool the LLM invoked, in order, with duration and outcome. Empty pre-Phase-4. */
  toolCalls: ToolCallLog[];
  /** Provable per-call compliance facts (recording notice, AI disclosure). */
  compliance: ComplianceLog;
  /** Provider usage as LiveKit tallied it — so cost is measured, not guessed. */
  usage: unknown;
  /** Both engines' transcripts, when SHADOW_STT_ENABLED. Same shape as the DB column. */
  shadow: ShadowSttTranscript | null;
}

/**
 * The exact LiveKit warning that means "she started replying while he was still talking".
 * Emitted by the agent framework when the STT's end-of-speech lands inside a VAD speech segment.
 */
const CUT_OFF_WARNING = 'stt end of speech received while vad is still in a speech segment';

export class CallReport {
  #startedAt = Date.now();
  #room: string;
  #callerPhone: string | null;
  #config: CallReportJson['config'];
  #metrics: TurnMetric[] = [];
  #transcript: TranscriptLine[] = [];
  #toolCalls: ToolCallLog[] = [];
  #compliance: ComplianceLog = {};
  #endDisclosureRequested = false;
  #usage: unknown = null;
  #shadow: ShadowSttTranscript | null = null;
  #cutOffs = 0;
  #pipeline: PipelineSnapshot | null = null;
  /**
   * A GETTER, not a stored value. `write()` runs after every turn (see agent.ts), so the counters
   * have to be re-read on each serialization — a snapshot taken once at install time would pin
   * every flush at zero and look exactly like a dead feature.
   */
  #preemptive: (() => PreemptiveCounters) | null = null;
  #restoreStderr: (() => void) | null = null;
  /** When the caller last stopped speaking, with no agent audio since. Null = already answered. */
  #userStoppedAt: number | null = null;
  #deadAir: number[] = [];

  constructor(room: string, callerPhone: string | null, config: CallReportJson['config']) {
    this.#room = room;
    this.#callerPhone = callerPhone;
    this.#config = config;
    this.#watchForCutOffs();
  }

  /**
   * Correct the recorded config after the tenant is known.
   *
   * The report is constructed at the top of the call, from env — before we know whose call this
   * is. A tenant running their own TTS voice would otherwise have every latency figure in this
   * report filed under the PLATFORM default voice, which is worse than not recording it: the TTS
   * numbers are exactly what these reports are read for, and they would be attributed to a voice
   * that never spoke on the call.
   */
  updateConfig(patch: Partial<CallReportJson['config']>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        (this.#config as Record<string, unknown>)[key] = value;
      }
    }
  }

  /**
   * The resolved pipeline, once the session is up. Taken after `session.start()` — before that,
   * the SDK has not finished merging defaults or re-resolving turn detection, so an earlier
   * snapshot would record the request rather than the result.
   */
  recordPipeline(snapshot: PipelineSnapshot): void {
    this.#pipeline = snapshot;
  }

  /** Where to read the live preemptive counters from at serialization time. See `#preemptive`. */
  attachPreemptive(read: () => PreemptiveCounters): void {
    this.#preemptive = read;
  }

  /**
   * Counts cut-offs by watching what LiveKit logs.
   *
   * Yes, this reads the framework's log output, which is not how one would normally detect
   * something. It is the honest option available: LiveKit emits no EVENT for this, and it is the
   * single most important health signal we have — the difference between "fast" and "she talked
   * over the customer" is invisible in every metric the framework does expose. The alternative was
   * to infer it by subtracting event counts, which produced NEGATIVE cut-offs on a healthy call.
   *
   * Wrapped in a try so a change in LiveKit's logging can never do worse than lose the counter.
   *
   * ⚠️ 2026-08-30, FOUND WHILE INSTRUMENTING THE PIPELINE — THIS IS WATCHING THE WRONG STREAM AND
   * HAS NEVER COUNTED ANYTHING. The warning is emitted through LiveKit's pino logger
   * (`audio_recognition.js` → `this.logger.warn`), and that logger writes to STDOUT:
   * `log.js` builds it as `pino({...}, multistream([{ stream: pretty ? pinoPretty() : process.stdout }, ...]))`.
   * Nothing in the agent SDK writes to stderr. So `cutOffs` has read 0 on every call ever recorded
   * for a second reason, on top of the vad/stt-mode one documented on the field itself.
   *
   * Left exactly as it is: this branch is observability-only and changing the stream changes what a
   * number means mid-flight. The fix belongs with the person who will re-read the calls it affects
   * — see docs/handoffs/2026-08-30-voice-observability.md. `PreemptiveObserver` in
   * pipeline-observer.ts shows the durable alternative: hook the logger object, not a byte stream.
   */
  #watchForCutOffs(): void {
    try {
      const original = process.stderr.write.bind(process.stderr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stderr.write = ((chunk: any, ...rest: any[]) => {
        try {
          if (typeof chunk === 'string' && chunk.includes(CUT_OFF_WARNING)) this.#cutOffs++;
        } catch {
          // Counting must never break the log line itself.
        }
        return original(chunk, ...rest);
      }) as typeof process.stderr.write;
      this.#restoreStderr = () => {
        process.stderr.write = original;
      };
    } catch {
      this.#restoreStderr = null;
    }
  }

  #toolCallLeaks = 0;
  readonly #toolCallLeakReasons: string[] = [];

  /**
   * One sentence had a tool-call payload cut out of it before it could be spoken.
   *
   * Called from `guardStream`'s leak hook. Deliberately takes only the REASONS and never the
   * payload: it carried the lead's name, business and pain point, and the report file is not a
   * place for PII (see redactArgs in tools/tool-context.ts).
   */
  recordToolCallLeak(reasons: readonly string[]): void {
    this.#toolCallLeaks++;
    for (const r of reasons) if (!this.#toolCallLeakReasons.includes(r)) this.#toolCallLeakReasons.push(r);
  }

  #falseBookingClaims = 0;

  /**
   * One sentence had a "the meeting is booked" claim rewritten out of it before it was spoken.
   *
   * Called from `guardStream`'s booking hook. Takes the SPOKEN result rather than the original for
   * the same reason `recordToolCallLeak` takes only reasons — and uses neither, because the count
   * is the whole signal and the sentence carries the lead's chosen time. See speech-guard.ts.
   */
  recordFalseBookingClaim(_spoken: string): void {
    this.#falseBookingClaims++;
  }

  #endCallRefusals = 0;
  readonly #endCallRefusalReasons: string[] = [];

  /** The disqualifying-hang-up gate refused one `end_call`. See end-call-gate.ts. */
  recordEndCallRefusal(code: string): void {
    this.#endCallRefusals++;
    if (!this.#endCallRefusalReasons.includes(code)) this.#endCallRefusalReasons.push(code);
  }

  #secondQuestionsDropped = 0;

  /** One sentence was dropped for being the second question in the same reply. */
  recordSecondQuestionDropped(): void {
    this.#secondQuestionsDropped++;
  }

  #coachNoteBytes: number[] = [];

  /**
   * The size of one coach note, in UTF-8 bytes, as it was injected.
   *
   * "Outside the ±5% system-prompt ceiling" is not "free" — it is unmeasured. The note is a tail
   * system item, so it never moves the cache prefix, but it IS re-sent on every turn like
   * everything else, and it GROWS: fact memory, the phrase ledger, the gate and the engagement
   * tracker each add lines as a call goes on. Nobody has ever counted what turn 30 of a long call
   * is carrying. This is that count, so the question becomes a decision instead of a shrug.
   */
  recordCoachNote(bytes: number): void {
    this.#coachNoteBytes.push(bytes);
  }

  #voiceModeTurns: Record<string, number> = { confident: 0, hesitant: 0, empathetic: 0 };
  #modeMarkerLeaks = 0;

  /** One inference step was synthesized in this register. See voice-mode.ts. */
  recordVoiceMode(mode: string): void {
    this.#voiceModeTurns[mode] = (this.#voiceModeTurns[mode] ?? 0) + 1;
  }

  /** A `[[...]]` marker reached the wide net still intact. Must be zero. */
  recordModeMarkerLeak(): void {
    this.#modeMarkerLeaks++;
  }

  #gateAViolations = 0;
  #gateAOpen = false;

  /** One sentence described the product while the discovery gate was still shut. */
  recordGateAViolation(): void {
    this.#gateAViolations++;
  }

  /** The gate's final state, read once at shutdown — not a counter. */
  recordGateAOpen(open: boolean): void {
    this.#gateAOpen = open;
  }

  #selfNarrationDropped = 0;

  /** One sentence was dropped for narrating her own instructions/register at the caller. */
  recordSelfNarrationDropped(): void {
    this.#selfNarrationDropped++;
  }

  #repeatedSentencesDropped = 0;

  /** One sentence was suppressed because she had already said it on this call. */
  recordRepeatedSentenceDropped(): void {
    this.#repeatedSentencesDropped++;
  }

  #stopAnnouncementsRewritten = 0;

  /** One unbacked "let us stop here" became the end-call gate's confirmation question. */
  recordStopAnnouncementRewritten(): void {
    this.#stopAnnouncementsRewritten++;
  }

  #productClaimSlangRewritten = 0;

  /** One claim about the product had its slang swapped for `מעולה` (round-13 s2). */
  recordProductClaimSlangRewritten(): void {
    this.#productClaimSlangRewritten++;
  }

  recordMetric(stage: string, m: Record<string, unknown>): void {
    const pick = (k: string): number | undefined =>
      typeof m[k] === 'number' ? Math.round(m[k] as number) : undefined;

    this.#metrics.push({
      atMs: Date.now() - this.#startedAt,
      stage,
      endOfUtteranceDelayMs: pick('endOfUtteranceDelayMs'),
      ttftMs: pick('ttftMs'),
      ttfbMs: pick('ttfbMs'),
      durationMs: pick('durationMs'),
      promptTokens: pick('promptTokens'),
      promptCachedTokens: pick('promptCachedTokens'),
      audioDurationMs: pick('audioDurationMs'),
      charactersCount: pick('charactersCount'),
      cancelled: typeof m.cancelled === 'boolean' ? m.cancelled : undefined,
    });
  }

  /**
   * One line of the conversation — the caller's or the agent's.
   *
   * DEDUPES THE AGENT'S OWN LINES, because `ConversationItemAdded` fires TWICE for one reply when
   * preemptive generation is on: once for the DRAFT message and again for the confirmed one, same
   * text. She says it once; the log recorded it twice.
   *
   * That artefact cost real credibility. I read the doubled lines, concluded the agent was speaking
   * every answer twice to the caller, told Koren it was the root cause of everything he disliked,
   * and switched off preemptive TTS on the strength of it. He had been ON the call — she never
   * repeated herself. The audio said so too (20 TTS segments for 19 transcript lines; a genuine
   * double would be ~30).
   *
   * The lesson is not "add a dedupe". It is that a log line is not evidence of a sound. When the
   * transcript and the person who was actually on the phone disagree, the person wins.
   */
  recordTranscript(
    role: string,
    text: string,
    /** The SDK's own per-message speaking timestamps, in EPOCH SECONDS as it reports them. */
    spoken?: { startedSpeakingAt?: number; stoppedSpeakingAt?: number },
  ): void {
    const trimmed = text?.trim();
    if (!trimmed) return;

    if (role === 'assistant') {
      const isDraftEcho = this.#transcript.some(
        (x) =>
          x.role === 'assistant' &&
          x.text === trimmed &&
          Date.now() - this.#startedAt - x.atMs < 20_000,
      );
      if (isDraftEcho) return;
    }

    const rel = (seconds: number | undefined): number | undefined =>
      typeof seconds === 'number' && Number.isFinite(seconds)
        ? Math.round(seconds * 1000 - this.#startedAt)
        : undefined;
    const spokeAtMs = rel(spoken?.startedSpeakingAt);
    const spokeUntilMs = rel(spoken?.stoppedSpeakingAt);

    this.#transcript.push({
      atMs: Date.now() - this.#startedAt,
      role,
      text: trimmed,
      ...(spokeAtMs !== undefined ? { spokeAtMs } : {}),
      ...(spokeUntilMs !== undefined ? { spokeUntilMs } : {}),
    });

    // Say it out loud as it happens, in the same shape as the other latency lines, so a live call
    // can be diagnosed by grepping the agent log instead of waiting for the report file.
    const gap = this.#agentGaps().at(-1);
    if (gap && gap.fromMs === this.#transcript.at(-2)?.spokeUntilMs) {
      console.log(
        `latency agent_gap ms=${gap.gapMs} toolMs=${gap.toolMs} ` +
          `unexplainedMs=${gap.gapMs - gap.toolMs} tools=${gap.tools.map((t) => t.name).join(',') || 'none'} ` +
          `endedBy=${gap.endedBy ?? 'reply'}`,
      );
    }
  }

  /**
   * The caller stopped speaking. Starts (or restarts) the dead-air stopwatch.
   *
   * RESTARTING ON EVERY STOP IS THE POINT, not a bug to fix later. When the turn detector shreds
   * one sentence into three, the caller does not experience three waits — they experience one,
   * measured from the last thing they said. Keeping the earliest stop instead would charge the
   * agent for the caller's own thinking pause and make fragmentation look like latency.
   */
  noteUserStoppedSpeaking(): void {
    this.#userStoppedAt = Date.now();
  }

  /** The caller started speaking again — there is no silence to measure until they stop. */
  noteUserStartedSpeaking(): void {
    this.#userStoppedAt = null;
  }

  /**
   * How long the caller has been waiting right now, or null if they are still talking.
   *
   * THE MEASUREMENT THAT WAS MISSING. `latency audio_path` timed the reply from the moment the
   * reply STARTED, and by that clock the acknowledgement leaves in 1-2ms — which looked like
   * success. But dead air on the same call ran to a median of 1254ms when end-of-turn (200ms) plus
   * TTS (229ms) predicts ~430ms. Both numbers were right; neither could see the ~800ms BEFORE
   * `llmNode` was ever called. Stamping the same log line against the caller's clock is what
   * distinguishes "our pipeline is slow" from "our pipeline was started late".
   */
  msSinceUserStopped(): number | null {
    return this.#userStoppedAt === null ? null : Date.now() - this.#userStoppedAt;
  }

  /**
   * The agent's first audio of a reply reached the caller. Closes the stopwatch.
   *
   * Only the FIRST speech after a stop counts: the stopwatch is cleared here, so the second and
   * third segments of one long answer do not each score a near-zero and drag the median down.
   */
  noteAgentStartedSpeaking(): void {
    if (this.#userStoppedAt === null) return;
    const ms = Date.now() - this.#userStoppedAt;
    this.#userStoppedAt = null;
    // A barge-in can put the agent into 'speaking' a hair before the caller's stop registers.
    // Negative silence is not a thing; drop the sample rather than record a flattering zero.
    if (ms < 0) return;
    this.#deadAir.push(ms);
    this.#metrics.push({ atMs: Date.now() - this.#startedAt, stage: 'dead_air', durationMs: ms });
    console.log(`latency dead_air ms=${ms}`);
  }

  recordUsage(usage: unknown): void {
    this.#usage = usage;
  }

  /** One tool invocation. `atMs` is stamped here so callers can't get the clock wrong. */
  recordToolCall(entry: ToolCallLog): void {
    this.#toolCalls.push({ ...entry, atMs: Date.now() - this.#startedAt });
  }

  /** A compliance fact, as it happens (e.g. the recording notice finished playing). */
  recordCompliance(patch: ComplianceLog): void {
    Object.assign(this.#compliance, patch);
  }

  /** end_call found no disclosure yet and instructed one into the goodbye. */
  markEndDisclosureRequested(): void {
    this.#endDisclosureRequested = true;
  }

  /** Did ANY agent line satisfy the predicate? Deterministic — reads the transcript, not the LLM. */
  someAgentLine(pred: (text: string) => boolean): boolean {
    return this.#transcript.some((line) => line.role === 'assistant' && pred(line.text));
  }

  /**
   * The caller's last committed turn, with the two facts a hang-up decision needs about it.
   *
   * ADDED FOR THE 260-SECOND HANG-UP (see end-call-gate.ts). The question "did he talk over her?"
   * was answerable from this object all along — `spokeAtMs` / `spokeUntilMs` are the SDK's own
   * per-message speaking clock — but nothing asked it, so `end_call` treated a half-second fragment
   * spoken inside her own sentence exactly like a considered answer.
   *
   * `overlappedAgentSpeech` is false when either side lacks speaking metrics. That is the honest
   * reading: no timestamps means no evidence of an overlap, and a gate that invented one would
   * refuse every hang-up on console mode, on tests, and on any reply that produced no audio.
   *
   * `agentTurnUnfinished` is the other half of the same story: at 260s her line ended
   * `אם זה עדיין מרגיש לךָ לא נכון` — no terminator, because he cut her off mid-conditional. A turn
   * that never became a question cannot have been answered.
   */
  lastCallerTurn(): {
    text: string;
    overlappedAgentSpeech: boolean;
    agentTurnBefore: string | null;
    agentTurnUnfinished: boolean;
  } | null {
    let callerIndex = -1;
    for (let i = this.#transcript.length - 1; i >= 0; i--) {
      if (this.#transcript[i]!.role === 'user') {
        callerIndex = i;
        break;
      }
    }
    if (callerIndex === -1) return null;
    const caller = this.#transcript[callerIndex]!;

    let agent: TranscriptLine | null = null;
    for (let i = callerIndex - 1; i >= 0; i--) {
      if (this.#transcript[i]!.role === 'assistant') {
        agent = this.#transcript[i]!;
        break;
      }
    }

    const overlapped =
      agent !== null &&
      typeof caller.spokeAtMs === 'number' &&
      typeof agent.spokeUntilMs === 'number' &&
      caller.spokeAtMs < agent.spokeUntilMs;

    // A sentence that ends in a terminator finished; anything else was interrupted or trailed off.
    // Trailing quotes/brackets are stepped over so a quoted line is not read as unfinished.
    const finished = agent === null || /[.!?…׃]["'׳״)\]]*$/u.test(agent.text.trim());

    return {
      text: caller.text,
      overlappedAgentSpeech: overlapped,
      agentTurnBefore: agent?.text ?? null,
      agentTurnUnfinished: agent !== null && !finished,
    };
  }

  /**
   * Settles `ai_disclosure` at shutdown from what was actually SAID:
   *   found + end_call had to ask for it  → 'at_end'
   *   found without being asked for       → 'during_call'
   *   not found anywhere                  → 'missed'   (the goodbye instruction was ignored — audit it)
   * Idempotent: an explicit earlier record (end_call saw a mid-call disclosure) wins.
   */
  resolveAiDisclosure(pred: (text: string) => boolean): void {
    if (this.#compliance.ai_disclosure) return;
    const disclosed = this.someAgentLine(pred);
    this.#compliance.ai_disclosure = disclosed
      ? this.#endDisclosureRequested
        ? 'at_end'
        : 'during_call'
      : 'missed';
  }

  attachShadow(shadow: ShadowSttTranscript): void {
    this.#shadow = shadow;
  }

  toJson(): CallReportJson {
    // Zeroes are barge-in artefacts, not turns — the caller cut her off, so there was no wait to
    // measure. Averaging them in would silently halve the end-of-turn figure.
    const eou = this.#metrics
      .map((m) => m.endOfUtteranceDelayMs)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    // -1 is LiveKit's sentinel for a generation that was CANCELLED before its first token — a
    // preemptive draft the caller's next word invalidated. Averaging those in does not measure a
    // fast LLM, it measures a wasted one, and it drags the median toward zero in exactly the
    // situation where the caller is waiting longest. It reported 314ms on a call whose real
    // time-to-first-token was 820-950ms on every turn that actually produced speech, and I read
    // that as the fix working. Cancelled drafts are counted separately, as `draftsDiscarded`.
    const ttft = this.#metrics
      .map((m) => m.ttftMs)
      .filter((v): v is number => typeof v === 'number' && v >= 0);
    const draftsDiscarded = this.#metrics.filter((m) => m.ttftMs === -1).length;
    const ttfb = this.#metrics
      .map((m) => m.ttfbMs)
      .filter((v): v is number => typeof v === 'number');

    const eouMed = median(eou);
    const ttftMed = median(ttft);
    // Recorded by llmNode under its own stage so it can never mix with the SDK's ttft above.
    const modelTtftMed = median(
      this.#metrics
        .filter((m) => m.stage === 'model_ttft')
        .map((m) => m.durationMs)
        .filter((v): v is number => typeof v === 'number'),
    );
    const ttfbMed = median(ttfb);

    // Cache hit rate across the whole call, weighted by tokens (not a mean of per-turn ratios —
    // the early turns are small and would drag a naive average around).
    const totalIn = this.#metrics.reduce((n, m) => n + (m.promptTokens ?? 0), 0);
    const totalCached = this.#metrics.reduce((n, m) => n + (m.promptCachedTokens ?? 0), 0);
    const promptCacheHitPct = totalIn > 0 ? Math.round((totalCached / totalIn) * 100) : null;

    const noteBytes = this.#coachNoteBytes;
    const coachNote = {
      turns: noteBytes.length,
      medianBytes: noteBytes.length > 0 ? Math.round(median(noteBytes) ?? 0) : null,
      maxBytes: noteBytes.length > 0 ? Math.max(...noteBytes) : null,
      growth:
        noteBytes.length > 1 && noteBytes[0]! > 0
          ? Math.round((noteBytes[noteBytes.length - 1]! / noteBytes[0]!) * 100) / 100
          : null,
    };

    // SPEECH PACE — see `speechPace` in the summary type for why this exists at all.
    // A synthesis with no characters or no audio is not a sample; a cancelled one is a sample of
    // something nobody heard. Both are excluded rather than counted as zero.
    const paceSamples = this.#metrics
      .filter((m) => m.cancelled !== true)
      .map((m) =>
        typeof m.charactersCount === 'number' &&
        m.charactersCount > 0 &&
        typeof m.audioDurationMs === 'number' &&
        m.audioDurationMs > 0
          ? m.audioDurationMs / m.charactersCount
          : null,
      )
      .filter((v): v is number => v !== null);
    const round2 = (v: number): number => Math.round(v * 100) / 100;
    const paceMin = paceSamples.length > 0 ? Math.min(...paceSamples) : null;
    const paceMax = paceSamples.length > 0 ? Math.max(...paceSamples) : null;
    const speechPace = {
      samples: paceSamples.length,
      medianMsPerChar: paceSamples.length > 0 ? round2(median(paceSamples) ?? 0) : null,
      minMsPerChar: paceMin === null ? null : round2(paceMin),
      maxMsPerChar: paceMax === null ? null : round2(paceMax),
      spread: paceMin !== null && paceMax !== null && paceMin > 0 ? round2(paceMax / paceMin) : null,
    };

    // Two caller turns in a row, within 3s, with no agent reply between them: one sentence that the
    // turn detector cut in half. See `fragmentedTurns` above for why this, and not `cutOffs`, is the
    // signal that matters on a vad-mode call.
    let fragmentedTurns = 0;
    let duplicateReplies = 0;
    let restartedReplies = 0;
    /** The silence INSIDE each chopped thought — see `fragmentation` in the summary type. */
    const fragmentGaps: number[] = [];
    for (let i = 1; i < this.#transcript.length; i++) {
      const prev = this.#transcript[i - 1]!;
      const curr = this.#transcript[i]!;
      if (prev.role === 'user' && curr.role === 'user' && curr.atMs - prev.atMs < 3_000) {
        fragmentedTurns++;
        // The gap between his two halves, off the SDK's speaking clocks rather than off the commit
        // timestamps. Bounded because a stitched STT hypothesis can stamp a start time from a
        // minute earlier: on the 2026-09-01 09:29 call two of the eleven produced 165s and -451s.
        const gap = (curr.spokeAtMs ?? NaN) - (prev.spokeUntilMs ?? NaN);
        if (Number.isFinite(gap) && gap >= 0 && gap <= 5_000) fragmentGaps.push(Math.round(gap));
      }
      // The same answer, twice. Compared against the last few agent turns rather than only the
      // previous line, because a caller interjection often lands between the draft and the repeat.
      if (curr.role === 'assistant' && curr.text.length > 15) {
        const recent = this.#transcript
          .slice(Math.max(0, i - 4), i)
          .filter((x) => x.role === 'assistant');
        // ⚠️ `===` WAS THE WHOLE OF THIS TEST UNTIL 2026-09-01, AND IT READ 0 ON A CALL WHERE SHE
        // BEGAN THE SAME SENTENCE THREE TIMES IN SEVEN SECONDS. A restarted turn is never
        // byte-identical: the interruption decides where it stops and lands somewhere new each
        // time, and the first of the three also carried the injected acknowledgement. So the exact
        // test is kept — a whole reply said twice is still worth its own signal — and `isRestartOf`
        // is added beside it. See repeat-guard.ts for the measurement and the call it comes from.
        if (recent.some((x) => x.text.trim() === curr.text.trim())) duplicateReplies++;
        else if (recent.some((x) => isRestartOf(x.text, curr.text))) {
          duplicateReplies++;
          restartedReplies++;
        }
      }
    }

    const agentLines = this.#transcript.filter((t) => t.role === 'assistant').map((t) => t.text);

    const agentGaps = this.#agentGaps();

    return {
      room: this.#room,
      callerPhone: this.#callerPhone,
      startedAt: new Date(this.#startedAt).toISOString(),
      durationSec: Math.round((Date.now() - this.#startedAt) / 1000),
      config: this.#config,
      pipeline: this.#pipeline,
      summary: {
        turnsHeard: eou.length,
        ttsSegments: this.#metrics.filter((m) => m.stage === 'tts_metrics').length,
        cutOffs: this.#cutOffs,
        fragmentedTurns,
        duplicateReplies,
        // `repeatedPhraseCount` is now 4-grams PLUS repeated openers — the number a person would
        // give if you asked them how often she repeated herself. `repeatedOpenerCount` keeps the
        // two halves legible, and countRepeatedFourGrams alone is still what the baseline script
        // compares against.
        repeatedPhraseCount: countRepeatedFourGrams(agentLines) + countRepeatedOpeners(agentLines),
        repeatedOpenerCount: countRepeatedOpeners(agentLines),
        consecutiveOpenerRepeats: countConsecutiveOpenerRepeats(agentLines),
        toolCallLeaks: this.#toolCallLeaks,
        toolCallLeakReasons: [...this.#toolCallLeakReasons],
        falseBookingClaims: this.#falseBookingClaims,
        endCallRefusals: this.#endCallRefusals,
        endCallRefusalReasons: [...this.#endCallRefusalReasons],
        secondQuestionsDropped: this.#secondQuestionsDropped,
        selfNarrationDropped: this.#selfNarrationDropped,
        voiceModeTurns: { ...this.#voiceModeTurns },
        modeMarkerLeaks: this.#modeMarkerLeaks,
        gateAViolations: this.#gateAViolations,
        gateAOpen: this.#gateAOpen,
        restartedReplies,
        repeatedSentencesDropped: this.#repeatedSentencesDropped,
        stopAnnouncementsRewritten: this.#stopAnnouncementsRewritten,
        productClaimSlangRewritten: this.#productClaimSlangRewritten,
        fragmentation: {
          samples: fragmentGaps.length,
          medianMs: median(fragmentGaps),
          maxMs: fragmentGaps.length > 0 ? Math.max(...fragmentGaps) : null,
          // How many of this call's chopped thoughts each candidate threshold would have held
          // together. The point is to size the endpointer from measurement instead of argument —
          // see `fragmentation` in the summary type for why we did not just raise the number.
          caughtAt: {
            500: fragmentGaps.filter((g) => g < 500).length,
            700: fragmentGaps.filter((g) => g < 700).length,
            900: fragmentGaps.filter((g) => g < 900).length,
            1200: fragmentGaps.filter((g) => g < 1200).length,
          },
        },
        registerTouchPct:
          agentLines.length === 0
            ? null
            : Math.round(
                (agentLines.filter((line) => hasRegisterTouch(line)).length / agentLines.length) * 100,
              ),
        promptCacheHitPct,
        coachNote,
        speechPace,
        draftsDiscarded,
        // try/catch, because a counter must never be the reason a call's record is lost — the
        // report is the only durable trace of a call and it is written on every turn.
        preemptive: (() => {
          try {
            return this.#preemptive?.() ?? null;
          } catch {
            return null;
          }
        })(),
        endOfTurnMedianMs: eouMed,
        llmTtftMedianMs: ttftMed,
        modelTtftMedianMs: modelTtftMed,
        ttsTtfbMedianMs: ttfbMed,
        // Uses the MODEL's ttft when we have it. Otherwise the instant acknowledgement would
        // silently shave ~840ms off this figure without a single stage getting faster.
        worstCaseMs:
          eouMed === null || (modelTtftMed ?? ttftMed) === null || ttfbMed === null
            ? null
            : Math.round(eouMed + (modelTtftMed ?? ttftMed)! + ttfbMed),
        agentGap: {
          medianMs: median(agentGaps.map((g) => g.gapMs)),
          maxMs: agentGaps.length ? Math.max(...agentGaps.map((g) => g.gapMs)) : null,
          samples: agentGaps.length,
          gaps: agentGaps,
        },
        deadAir: {
          medianMs: median(this.#deadAir),
          p90Ms: percentile(this.#deadAir, 90),
          minMs: this.#deadAir.length ? Math.min(...this.#deadAir) : null,
          maxMs: this.#deadAir.length ? Math.max(...this.#deadAir) : null,
          samples: this.#deadAir.length,
        },
      },
      transcript: this.#transcript,
      metrics: this.#metrics,
      toolCalls: this.#toolCalls,
      compliance: this.#compliance,
      usage: this.#usage,
      shadow: this.#shadow,
    };
  }

  /**
   * The intra-turn silences, paired with the tools that ran inside them.
   *
   * A gap is counted only between two ASSISTANT lines with no user line between: that is one reply
   * that spoke, stopped, and spoke again — the tool-call shape. Two replies either side of a caller
   * turn are not a gap, they are a conversation.
   *
   * Needs the SDK's speaking timestamps on both lines. A call recorded before those existed, or a
   * step that produced no audio at all, simply contributes nothing rather than a wrong number.
   */
  #agentGaps(): AgentGap[] {
    const gaps: AgentGap[] = [];
    for (let i = 1; i < this.#transcript.length; i++) {
      const prev = this.#transcript[i - 1]!;
      const curr = this.#transcript[i]!;
      if (prev.role !== 'assistant' || curr.role !== 'assistant') continue;
      const from = prev.spokeUntilMs;
      const to = curr.spokeAtMs;
      if (from === undefined || to === undefined) continue;
      const gapMs = to - from;
      if (gapMs <= 0) continue;

      // A tool "ran inside the gap" if it FINISHED in it — recordToolCall stamps atMs at
      // completion, so its window is [atMs - durationMs, atMs].
      const tools = this.#toolCalls
        .filter((t) => t.atMs > from && t.atMs <= to + 250)
        .map((t) => ({ name: t.name, durationMs: t.durationMs }));
      // Same window, same reasoning, for the timers that speak on their own. A reflex line is the
      // LAST thing that happens in a gap, so its metric lands just before the audio it triggered.
      const reflex = this.#metrics.find(
        (m) => (REFLEX_STAGES as readonly string[]).includes(m.stage) && m.atMs > from && m.atMs <= to + 250,
      );
      gaps.push({
        fromMs: from,
        gapMs,
        tools,
        toolMs: tools.reduce((n, t) => n + t.durationMs, 0),
        ...(reflex ? { endedBy: reflex.stage as ReflexStage } : {}),
      });
    }
    return gaps;
  }

  /** Writes the report and returns its path. Never throws — losing a report must not fail a call. */
  async write(dir: string): Promise<string | null> {
    this.#restoreStderr?.();
    try {
      await mkdir(dir, { recursive: true });
      const stamp = new Date(this.#startedAt).toISOString().replace(/[:.]/gu, '-');
      const path = join(dir, `${stamp}.json`);
      await writeFile(path, `${JSON.stringify(this.toJson(), null, 2)}\n`);
      return path;
    } catch (err) {
      console.error('call_report_write_failed', err instanceof Error ? err.message : String(err));
      return null;
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!);
}

/**
 * Nearest-rank percentile. On the handful of turns a sales call produces, this reduces to "the
 * worst one or two", which is exactly the intent: the median says how the call felt on average,
 * this says how it felt when it went wrong.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, rank - 1))]!);
}
