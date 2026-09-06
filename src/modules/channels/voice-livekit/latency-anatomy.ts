/**
 * PER-TURN LATENCY ANATOMY — one row per caller turn, derived from the metrics a call report
 * already carries.
 *
 * WHY THIS EXISTS. Every latency figure in the summary is a median over the WHOLE call, and the
 * whole call is not one population. On the 2026-09-03 15:12 production call the six turns split
 * 552 / 1438 / 1478 / 1578 / 2877 / 3113 ms — a median of 1529ms that describes none of them. The
 * populations behind that spread have different fixes:
 *
 *   - a turn whose instant receipt leaves BEFORE the model's first token   -> ~500ms of silence
 *   - a turn with no early receipt (question turn, spent ledger)           -> 1.5s
 *   - a turn that ran a tool, and so paid a second inference               -> 3s
 *
 * Optimising against the pooled median cannot tell those apart, and three sessions have now
 * argued about the instant acknowledgement from pooled numbers. This groups the metrics the
 * report has always carried into the turns they belong to, so the argument becomes arithmetic.
 *
 * PURE BY CONSTRUCTION. It reads a finished report's arrays and computes; it observes nothing
 * live, changes no behaviour, and runs over reports written before it existed — any field it
 * cannot find is `null`, never zero. A zero here would be a metric that flatters, which is the
 * failure mode this module was written to end (see docs/phase-4-known-issues.md §14).
 */

/** The subset of `TurnMetric` this module needs. Structural, so `TurnMetric` satisfies it. */
export interface AnatomyMetric {
  atMs: number;
  stage: string;
  endOfUtteranceDelayMs?: number | undefined;
  ttftMs?: number | undefined;
  ttfbMs?: number | undefined;
  durationMs?: number | undefined;
  promptTokens?: number | undefined;
  promptCachedTokens?: number | undefined;
  cancelled?: boolean | undefined;
  enteredMs?: number | undefined;
  kind?: string | undefined;
  reason?: string | undefined;
}

/** The subset of `ToolCallLog` this module needs. */
export interface AnatomyToolCall {
  name: string;
  atMs?: number | undefined;
  durationMs?: number | undefined;
}

/**
 * How this turn's first audio came to be — the axis every step of the latency work is judged on.
 *
 * `tool_step` wins over the other two when a tool ran, because a tool turn's wait is dominated by
 * the round-trip plus the SECOND inference it forces; mixing those into the receipt question is
 * part of why the receipt looked worthless. And `receipt_early` is deliberately not "a receipt was
 * chosen" — it is "audio was on the wire before the model's first token", which is the only
 * version of that claim a report can actually witness.
 */
export type TurnClass = 'receipt_early' | 'no_receipt' | 'tool_step' | 'unknown';

export interface TurnAnatomy {
  /** 1-based over turns the SDK reported an end-of-turn for. 0 = the greeting. */
  index: number;
  /** ms since call start, at the end-of-turn event that opened this turn. */
  atMs: number;
  /**
   * The SDK's end-of-utterance delay. NULL when it reported 0 — a zero is a barge-in or an
   * already-final transcript, not a turn that waited, and averaging it in halves the figure.
   */
  eouMs: number | null;
  /** Caller stopped -> her first audio out, from the session's own state transitions. */
  deadAirMs: number | null;
  /** The same wait, measured at the audio frame inside `ttsNode`. Should track `deadAirMs`. */
  firstAudioMs: number | null;
  /** The MODEL's real first token, from `llmNode` — not the SDK's ttft, which times our receipt. */
  modelTtftMs: number | null;
  /** First non-cancelled TTS first-byte in the turn. */
  ttsTtfbMs: number | null;
  /**
   * When the voice node was ENTERED, on the caller's clock — i.e. when the SDK finally handed this
   * reply to the audio path. Everything before it is scheduling; everything after is synthesis.
   */
  voiceEnteredMs: number | null;
  /** When the first text left the guard for the TTS, on the same clock. */
  textToVoiceMs: number | null;
  /** Inference steps that produced tokens. Above 1 means a tool forced a second generation. */
  inferenceSteps: number;
  /** Preemptive drafts cancelled before their first token (LiveKit's -1 sentinel). */
  draftsDiscarded: number;
  promptTokens: number | null;
  promptCachedTokens: number | null;
  /**
   * What `deadAirMs` costs beyond the two stages we can see: `deadAir - modelTtft - ttsTtfb`.
   *
   * It is NOT slack in the pipeline — the model's first token is timed from the reply starting,
   * not from the caller stopping, so this holds the wait before `llmNode` was invoked plus the
   * generation of the first sentence after the first token. It is the term to watch: on the
   * 2026-09-03 call it ran 165-236ms, which says the pipeline is tight and the LLM's first token
   * is the whole story on a turn with no early receipt. If it ever grows, something new is
   * holding finished text.
   */
  unexplainedMs: number | null;
  /** What she opened her mouth with, on a build that records it. */
  opener: string | null;
  openerReason: string | null;
  toolNames: string[];
  toolMs: number;
  /**
   * Did audio start before the model's first token? `null` when either number is missing.
   * THE question the instant acknowledgement exists to answer.
   */
  audioBeforeFirstToken: boolean | null;
  klass: TurnClass;
}

/** Every stage this module reads, named once so a stage rename cannot fail silently. */
const STAGE = {
  eou: 'eou_metrics',
  deadAir: 'dead_air',
  firstAudio: 'first_audio_frame',
  modelTtft: 'model_ttft',
  llm: 'llm_metrics',
  tts: 'tts_metrics',
  opener: 'turn_opener',
  voicePath: 'voice_path',
} as const;

/** `first_audio_frame` reports this when the caller had not stopped — the greeting, or a barge-in. */
const NO_CALLER_CLOCK = -1;

/**
 * Splits a call's metrics into turns and describes each one.
 *
 * THE BOUNDARY IS THE END-OF-TURN EVENT, deliberately: it is the only stage the SDK emits exactly
 * once per caller turn. Everything from one `eou_metrics` up to the next belongs to that turn, so
 * a reply's LLM and TTS work lands on the turn that caused it even when the reply runs long. What
 * precedes the first end-of-turn is the greeting, reported as index 0 with a null `eouMs` — it has
 * no caller waiting behind it and must never be averaged with the others.
 */
export function buildTurnAnatomy(
  metrics: readonly AnatomyMetric[],
  toolCalls: readonly AnatomyToolCall[] = [],
): TurnAnatomy[] {
  const boundaries = metrics.filter((m) => m.stage === STAGE.eou).map((m) => m.atMs);
  // The greeting's window opens at 0. With no end-of-turn at all the whole call is one row, which
  // is the honest reading of a call where the caller never spoke.
  const starts = [0, ...boundaries];
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const turns: TurnAnatomy[] = [];

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : Number.POSITIVE_INFINITY;
    // `>= from` and `< to`: the boundary event itself belongs to the turn it opens.
    const inWindow = metrics.filter((m) => m.atMs >= from && m.atMs < to);

    const eouRaw = num(inWindow.find((m) => m.stage === STAGE.eou)?.endOfUtteranceDelayMs);
    const llm = inWindow.filter((m) => m.stage === STAGE.llm);
    // A cancelled draft reports 0 prompt tokens. Counting that as this turn's input size reads as
    // a call that sent no prompt at all, which is how `0(NaN%)` appeared in the first table.
    const realLlm = llm.filter((m) => m.cancelled !== true && (num(m.promptTokens) ?? 0) > 0);
    const opener = inWindow.find((m) => m.stage === STAGE.opener);
    const tools = toolCalls.filter(
      (t) => typeof t.atMs === 'number' && t.atMs >= from && t.atMs < to,
    );

    // The FIRST sample of each, not the median: the caller's wait ended at the first audio, and a
    // long reply's later sentences would flatter every one of these numbers.
    const firstAudio = num(
      inWindow.find((m) => m.stage === STAGE.firstAudio && num(m.durationMs) !== NO_CALLER_CLOCK)
        ?.durationMs,
    );
    const modelTtft = num(inWindow.find((m) => m.stage === STAGE.modelTtft)?.durationMs);
    const ttsTtfb = num(inWindow.find((m) => m.stage === STAGE.tts && m.cancelled !== true)?.ttfbMs);
    // Same sentinel as first_audio_frame: -1 means the caller was not waiting, not "instant".
    const voicePath = inWindow.find(
      (m) => m.stage === STAGE.voicePath && num(m.durationMs) !== NO_CALLER_CLOCK,
    );

    const audioBeforeFirstToken =
      firstAudio === null || modelTtft === null ? null : firstAudio < modelTtft;

    const klass: TurnClass =
      tools.length > 0
        ? 'tool_step'
        : audioBeforeFirstToken === null
          ? 'unknown'
          : audioBeforeFirstToken
            ? 'receipt_early'
            : 'no_receipt';

    const deadAir = num(inWindow.find((m) => m.stage === STAGE.deadAir)?.durationMs);

    turns.push({
      index: i,
      atMs: from,
      eouMs: eouRaw !== null && eouRaw > 0 ? eouRaw : null,
      deadAirMs: deadAir,
      firstAudioMs: firstAudio,
      modelTtftMs: modelTtft,
      ttsTtfbMs: ttsTtfb,
      voiceEnteredMs: (() => {
        const v = num(voicePath?.enteredMs);
        return v === null || v === NO_CALLER_CLOCK ? null : v;
      })(),
      textToVoiceMs: num(voicePath?.durationMs),
      // A step that produced no token is a cancelled draft, counted on its own line instead.
      inferenceSteps: llm.filter((m) => num(m.ttftMs) !== NO_CALLER_CLOCK).length,
      draftsDiscarded: llm.filter((m) => num(m.ttftMs) === NO_CALLER_CLOCK).length,
      promptTokens: num(realLlm[0]?.promptTokens),
      promptCachedTokens: num(realLlm[0]?.promptCachedTokens),
      unexplainedMs:
        deadAir === null || modelTtft === null || ttsTtfb === null
          ? null
          : deadAir - modelTtft - ttsTtfb,
      opener: opener?.kind ?? null,
      openerReason: opener?.reason ?? null,
      toolNames: tools.map((t) => t.name),
      toolMs: tools.reduce((n, t) => n + (num(t.durationMs) ?? 0), 0),
      audioBeforeFirstToken,
      klass,
    });
  }

  return turns;
}

export interface ClassStats {
  n: number;
  deadAirP50: number | null;
  deadAirP75: number | null;
  deadAirP90: number | null;
  modelTtftP50: number | null;
  ttsTtfbP50: number | null;
  firstAudioP50: number | null;
}

export interface LatencySummary {
  /** Caller turns described, excluding the greeting. */
  turns: number;
  /** Of the turns we can judge, the share whose audio started before the model's first token. */
  audioBeforeFirstTokenPct: number | null;
  /** How many turns could be judged on that question at all. */
  audioBeforeFirstTokenSamples: number;
  byClass: Record<TurnClass, ClassStats>;
  /** Every caller turn pooled — the figure the summary already reports, for cross-checking. */
  all: ClassStats;
}

const CLASSES: readonly TurnClass[] = ['receipt_early', 'no_receipt', 'tool_step', 'unknown'];

/**
 * Percentiles per turn class.
 *
 * THE GREETING IS EXCLUDED. It has no caller waiting behind it and its numbers are cold-start
 * numbers; including it moves every median in the flattering direction on a short call.
 */
export function summarizeLatency(turns: readonly TurnAnatomy[]): LatencySummary {
  const callerTurns = turns.filter((t) => t.index > 0);
  const judged = callerTurns.filter((t) => t.audioBeforeFirstToken !== null);
  const early = judged.filter((t) => t.audioBeforeFirstToken === true);

  const byClass = Object.fromEntries(
    CLASSES.map((k) => [k, classStats(callerTurns.filter((t) => t.klass === k))]),
  ) as Record<TurnClass, ClassStats>;

  return {
    turns: callerTurns.length,
    audioBeforeFirstTokenPct:
      judged.length === 0 ? null : Math.round((early.length / judged.length) * 100),
    audioBeforeFirstTokenSamples: judged.length,
    byClass,
    all: classStats(callerTurns),
  };
}

function classStats(rows: readonly TurnAnatomy[]): ClassStats {
  const pick = (f: (t: TurnAnatomy) => number | null): number[] =>
    rows.map(f).filter((v): v is number => v !== null);
  const dead = pick((t) => t.deadAirMs);
  return {
    n: rows.length,
    deadAirP50: percentile(dead, 50),
    deadAirP75: percentile(dead, 75),
    deadAirP90: percentile(dead, 90),
    modelTtftP50: percentile(
      pick((t) => t.modelTtftMs),
      50,
    ),
    ttsTtfbP50: percentile(
      pick((t) => t.ttsTtfbMs),
      50,
    ),
    firstAudioP50: percentile(
      pick((t) => t.firstAudioMs),
      50,
    ),
  };
}

/**
 * Nearest-rank percentile — the same definition `call-report.ts` uses, duplicated rather than
 * shared because this module must stay importable without pulling the report in.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, rank - 1))]!);
}
