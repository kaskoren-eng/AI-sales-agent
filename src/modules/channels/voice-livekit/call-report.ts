import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShadowSttTranscript } from '../../../db/schema/call-learnings.js';

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
}

/** One line of the conversation, either side of it. */
export interface TranscriptLine {
  atMs: number;
  /** 'user' = the caller, 'assistant' = the agent. */
  role: string;
  text: string;
}

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
     */
    duplicateReplies: number;
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
     */
    draftsDiscarded: number;
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
   * Counts cut-offs by watching what LiveKit logs.
   *
   * Yes, this reads the framework's log output, which is not how one would normally detect
   * something. It is the honest option available: LiveKit emits no EVENT for this, and it is the
   * single most important health signal we have — the difference between "fast" and "she talked
   * over the customer" is invisible in every metric the framework does expose. The alternative was
   * to infer it by subtracting event counts, which produced NEGATIVE cut-offs on a healthy call.
   *
   * Wrapped in a try so a change in LiveKit's logging can never do worse than lose the counter.
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
  recordTranscript(role: string, text: string): void {
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

    this.#transcript.push({ atMs: Date.now() - this.#startedAt, role, text: trimmed });
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

    // Two caller turns in a row, within 3s, with no agent reply between them: one sentence that the
    // turn detector cut in half. See `fragmentedTurns` above for why this, and not `cutOffs`, is the
    // signal that matters on a vad-mode call.
    let fragmentedTurns = 0;
    let duplicateReplies = 0;
    for (let i = 1; i < this.#transcript.length; i++) {
      const prev = this.#transcript[i - 1]!;
      const curr = this.#transcript[i]!;
      if (prev.role === 'user' && curr.role === 'user' && curr.atMs - prev.atMs < 3_000) {
        fragmentedTurns++;
      }
      // The same answer, twice. Compared against the last few agent turns rather than only the
      // previous line, because a caller interjection often lands between the draft and the repeat.
      if (curr.role === 'assistant' && curr.text.length > 15) {
        const recent = this.#transcript
          .slice(Math.max(0, i - 4), i)
          .filter((x) => x.role === 'assistant');
        if (recent.some((x) => x.text.trim() === curr.text.trim())) duplicateReplies++;
      }
    }

    return {
      room: this.#room,
      callerPhone: this.#callerPhone,
      startedAt: new Date(this.#startedAt).toISOString(),
      durationSec: Math.round((Date.now() - this.#startedAt) / 1000),
      config: this.#config,
      summary: {
        turnsHeard: eou.length,
        ttsSegments: this.#metrics.filter((m) => m.stage === 'tts_metrics').length,
        cutOffs: this.#cutOffs,
        fragmentedTurns,
        duplicateReplies,
        promptCacheHitPct,
        draftsDiscarded,
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
