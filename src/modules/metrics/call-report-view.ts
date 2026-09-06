/**
 * ONE CALL'S REPORT, SHAPED FOR A PAGE.
 *
 * `call_learnings.call_report` has held the whole of every LiveKit call since the engine went live:
 * latency metrics, both sides of the transcript, tool calls, compliance. Nothing ever read a single
 * call's copy — `metrics.service.ts` reads the column only in aggregate — so the data has been
 * collected all along and never shown. This module is the reader. It adds no measurement of its own.
 *
 * THREE STATES, NEVER TWO. Every field here distinguishes "not measured" from "measured as zero"
 * from "measured as non-zero". A report written before a counter existed cannot answer a question
 * that did not exist when it was written, and rendering that absence as `0` turns a gap into a
 * claim. `scripts/show-call-report.mjs` states the same rule for the terminal; this is the wire
 * version of it. Nothing in this file uses `?? 0` on a measurement.
 *
 * IT COMPUTES NO LATENCY. Per-turn timing comes entirely from `buildTurnAnatomy` in
 * voice-livekit/latency-anatomy.ts — VOICE's file, imported and never edited, so the `-1`
 * `first_audio_frame` sentinel keeps exactly one owner. The tempting shortcut, pairing `ttftMs`
 * against `spokeAtMs` to recover "caller stopped -> her first sound", is the mistake this project
 * has already made twice: that pairing structurally cannot see the instant acknowledgement, so it
 * reports a number wrong in the flattering direction. `ttftMs` is not read here at all.
 *
 * INPUT IS `unknown` ON PURPOSE. `PersistedCallReport` is a documented subset; the JSON the agent
 * actually writes carries ~35 more summary keys, and older rows match neither shape. Every read
 * narrows defensively, and no unrecognised key is dropped on the way out.
 */
import {
  buildTurnAnatomy,
  summarizeLatency,
  type AnatomyMetric,
  type AnatomyToolCall,
  type LatencySummary,
  type TurnAnatomy,
} from '../channels/voice-livekit/latency-anatomy.js';

/**
 * Stage names owned by `latency-anatomy.ts`'s private `STAGE` map, mirrored here because the join
 * has to look at the raw metrics to tell "the caller was not waiting" apart from "nothing was
 * recorded". Neither failure mode on a rename invents a number: renaming `eou_metrics` trips
 * `turnsDetected` and suppresses every badge with a stated reason, and renaming `first_audio_frame`
 * degrades every badge to "not recorded". Both are pinned by test.
 */
const STAGE_EOU = 'eou_metrics';
const STAGE_FIRST_AUDIO = 'first_audio_frame';

/** The per-tool budget from the methodology — the one CallDetail already tints amber against. */
const TOOL_BUDGET_MS = 500;
/** The product's hard requirement: past a second of silence the caller hears a machine. */
const DEAD_AIR_BUDGET_MS = 1000;
/** Below this many samples a median is a rumour, so the verdict warns rather than passing. */
const DEAD_AIR_MIN_SAMPLES = 6;

/**
 * What the badge on one of her turns is allowed to say.
 *
 * `{ state: 'measured', ms: 0 }` is legal and means a genuinely instant reply — a measured zero is
 * a measurement, and folding it into an absence would be the same lie in the other direction.
 */
export type FirstAudio =
  /**
   * `source` names the instrument, because there are two and they are not interchangeable
   * evidence. `latency-anatomy.ts` documents `deadAirMs` as "caller stopped -> her first audio
   * out, from the session's own state transitions" and `firstAudioMs` as "the same wait, measured
   * at the audio frame inside ttsNode" — the same quantity, measured in two places. Of the 61 call
   * reports captured up to 2026-09-02, exactly one carries `first_audio_frame` and 23 carry
   * `dead_air`, so preferring the first and refusing the second would print "not recorded" on
   * almost every call we have. The page shows the number and says which instrument produced it.
   */
  | { state: 'measured'; ms: number; source: 'first_audio_frame' | 'dead_air' }
  /** The `-1` sentinel: the greeting, a barge-in, or a turn she began before he finished. */
  | { state: 'caller_not_waiting' }
  /** This build recorded no usable sample of the wait for this turn. */
  | { state: 'not_recorded' };

export interface ReportTranscriptLine {
  /** When the line was COMMITTED. For her lines the SDK commits at the END of playout. */
  atMs: number;
  /** Verbatim: 'user' | 'assistant' today, whatever a future build writes tomorrow. */
  role: string;
  text: string;
  /** When her voice actually started/stopped. Absent when the step produced no audio. */
  spokeAtMs: number | null;
  spokeUntilMs: number | null;
  /** Which turn window the line fell in, or null when there are no windows. */
  turnIndex: number | null;
  /** Non-null on exactly one line per turn — the one that made the sound. */
  firstAudio: FirstAudio | null;
}

/** A tool call as the page needs it. `args` is deliberately not carried — see `buildCallReportView`. */
export interface ReportToolCall {
  atMs: number | null;
  name: string;
  durationMs: number | null;
  ok: boolean | null;
  error: string | null;
}

export type VerdictId =
  | 'cut_offs'
  | 'fragmented_turns'
  | 'duplicate_replies'
  | 'tool_call_leaks'
  | 'false_booking_claims'
  | 'recording_notice'
  | 'ai_disclosure'
  | 'tool_failures'
  | 'tool_budget'
  | 'caller_hung_up'
  | 'dead_air_budget'
  | 'booking_outcome';

export interface Verdict {
  id: VerdictId;
  status: 'pass' | 'warn' | 'fail';
  /** The measured number behind the verdict. Never a default, never a stand-in. */
  value: number | null;
  unit: 'count' | 'ms' | 'none';
  detail?: Record<string, string | number | boolean>;
}

export interface CallReportView {
  /**
   * The report as written, passed through. `summary` especially is VERBATIM — no re-keying, no
   * allowlist — so a counter VOICE adds tomorrow reaches the page with no dashboard change.
   */
  raw: {
    room: string | null;
    callerPhone: string | null;
    startedAt: string | null;
    durationSec: number | null;
    config: Record<string, unknown> | null;
    pipeline: unknown;
    summary: Record<string, unknown>;
    compliance: Record<string, unknown> | null;
    usage: unknown;
  };
  turns: TurnAnatomy[];
  /** Where `turns` came from. See the recompute-first note in `buildCallReportView`. */
  turnsSource: 'derived' | 'report' | 'none';
  /** False when no end-of-turn boundary was found at all — badges are suppressed page-wide. */
  turnsDetected: boolean;
  /** Recomputed here; `summarizeLatency` has already excluded the greeting. */
  latency: LatencySummary | null;
  /** `summary.latency` exactly as the agent computed it that day, for comparison. Not merged. */
  latencyFromReport: LatencySummary | null;
  transcript: ReportTranscriptLine[];
  /** null means the report carries no array at all — which is not the same as "no tools ran". */
  toolCalls: ReportToolCall[] | null;
  verdicts: Verdict[];
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/** A number only when it really is one. NaN and Infinity are not measurements. */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * Builds the whole view, or null when `persisted` is not an object.
 *
 * Never throws, on any JSON value at all: this runs over rows written by builds that no longer
 * exist, and a report that cannot be parsed must degrade to "nothing to show" rather than 500 the
 * operator console.
 */
export function buildCallReportView(
  persisted: unknown,
  extra?: { endReason?: unknown },
): CallReportView | null {
  const r = asObject(persisted);
  if (!r) return null;

  const summary = asObject(r.summary) ?? {};
  const compliance = asObject(r.compliance);
  const metrics = (asArray(r.metrics) ?? []).filter(
    (m): m is AnatomyMetric => asObject(m) !== null,
  );

  // `args` is dropped on the way out. It is pre-redacted by `redactArgs()` at write time, but that
  // guarantee belongs to whichever build wrote the row, and this payload goes to a browser. The
  // page has no use for it, so the safe thing and the useful thing agree.
  const toolCallsRaw = asArray(r.toolCalls);
  const toolCalls: ReportToolCall[] | null =
    toolCallsRaw === null
      ? null
      : toolCallsRaw.flatMap((t) => {
          const o = asObject(t);
          if (!o) return [];
          return [
            {
              atMs: numOrNull(o.atMs),
              name: strOrNull(o.name) ?? 'unknown',
              durationMs: numOrNull(o.durationMs),
              ok: boolOrNull(o.ok),
              error: strOrNull(o.error),
            },
          ];
        });

  const anatomyTools: AnatomyToolCall[] = (toolCalls ?? []).map((t) => ({
    name: t.name,
    ...(t.atMs === null ? {} : { atMs: t.atMs }),
    ...(t.durationMs === null ? {} : { durationMs: t.durationMs }),
  }));

  // RECOMPUTE FIRST, deliberately. Newer rows already carry a `turns` array, but it was produced by
  // whichever version of latency-anatomy.ts shipped that day. Recomputing gives one code path over
  // every call ever made, works on the rows written before `turns` existed, and means a fix VOICE
  // lands in that file improves every historical call retroactively. The report's own figures are
  // still carried, untouched, as `latencyFromReport` — compared, never silently overwritten.
  const reportTurns = asArray(r.turns);
  let turns: TurnAnatomy[] = [];
  let turnsSource: CallReportView['turnsSource'] = 'none';
  if (metrics.length > 0) {
    turns = buildTurnAnatomy(metrics, anatomyTools);
    turnsSource = 'derived';
  } else if (reportTurns !== null && reportTurns.length > 0) {
    turns = reportTurns.filter((t): t is TurnAnatomy => asObject(t) !== null);
    turnsSource = turns.length > 0 ? 'report' : 'none';
  }

  const turnsDetected = metrics.some((m) => m.stage === STAGE_EOU);

  const lines: ReportTranscriptLine[] = (asArray(r.transcript) ?? []).flatMap((l) => {
    const o = asObject(l);
    if (!o) return [];
    return [
      {
        atMs: numOrNull(o.atMs) ?? 0,
        role: strOrNull(o.role) ?? 'unknown',
        text: strOrNull(o.text) ?? '',
        spokeAtMs: numOrNull(o.spokeAtMs),
        spokeUntilMs: numOrNull(o.spokeUntilMs),
        turnIndex: null,
        firstAudio: null,
      },
    ];
  });

  // No end-of-turn boundary means `buildTurnAnatomy` returned ONE window covering the whole call.
  // Badging off that window would print the greeting's number on every reply she made, so the page
  // gets no badges at all and says why.
  const transcript = turnsDetected ? joinTranscriptToTurns(lines, turns, metrics) : lines;

  return {
    raw: {
      room: strOrNull(r.room),
      callerPhone: strOrNull(r.callerPhone),
      startedAt: strOrNull(r.startedAt),
      durationSec: numOrNull(r.durationSec),
      config: asObject(r.config),
      pipeline: r.pipeline ?? null,
      summary,
      compliance,
      usage: r.usage ?? null,
    },
    turns,
    turnsSource,
    turnsDetected,
    latency: turns.length > 0 ? summarizeLatency(turns) : null,
    latencyFromReport: (asObject(summary.latency) as LatencySummary | null) ?? null,
    transcript,
    toolCalls,
    verdicts: buildVerdicts({
      summary,
      compliance,
      toolCalls,
      ...(extra?.endReason === undefined ? {} : { endReason: extra.endReason }),
    }),
  };
}

/**
 * Puts each transcript line in the turn it belongs to, and one latency badge on each turn.
 *
 * WINDOWS ARE READ OFF THE ANATOMY, not recomputed. `buildTurnAnatomy` starts turn `i` at
 * `turns[i].atMs`, so the window is `[turns[i].atMs, turns[i+1].atMs)` and is recoverable from its
 * public output. Re-deriving the boundaries by filtering `eou_metrics` here would put a second copy
 * of VOICE's windowing rule in dashboard code, and the day they change it this would desync while
 * both files still typecheck.
 */
export function joinTranscriptToTurns(
  lines: readonly ReportTranscriptLine[],
  turns: readonly TurnAnatomy[],
  metrics: readonly AnatomyMetric[],
): ReportTranscriptLine[] {
  const out: ReportTranscriptLine[] = lines.map((l) => ({
    ...l,
    turnIndex: null,
    firstAudio: null,
  }));
  if (turns.length === 0) return out;

  const windows = turns.map((t, i) => ({
    index: t.index,
    turn: t,
    from: t.atMs,
    // Half-open, matching upstream: a line landing exactly on a boundary belongs to the LATER turn.
    to: i + 1 < turns.length ? turns[i + 1]!.atMs : Number.POSITIVE_INFINITY,
  }));

  // PLACED BY THE SOUND, NOT THE COMMIT. `atMs` is when the SDK committed the line, and it commits
  // an assistant message at the END of its playout — so a long reply followed by a quick caller
  // turn commits AFTER the next end-of-turn and would land one window late. `spokeAtMs` is when her
  // audio actually started, and is always inside the window that caused it.
  for (const line of out) {
    const key = line.spokeAtMs ?? line.atMs;
    line.turnIndex = windows.find((w) => key >= w.from && key < w.to)?.index ?? null;
  }

  for (const w of windows) {
    const spoken = out.filter((l) => l.turnIndex === w.index && l.role === 'assistant');
    if (spoken.length === 0) continue;
    spoken.sort((a, b) => (a.spokeAtMs ?? a.atMs) - (b.spokeAtMs ?? b.atMs));
    // Prefer a line we KNOW produced audio. A tool-only step or an interrupted reply carries no
    // `spokeAtMs` and never made the sound `first_audio_frame` timed, so it must not take the badge
    // off the line that did.
    const opener = spoken.find((l) => l.spokeAtMs !== null) ?? spoken[0]!;
    opener.firstAudio = classifyFirstAudio(w.turn, w.from, w.to, metrics);
    // Every other line keeps `firstAudio: null` and the page renders NOTHING there — not a dash.
    // A dash says a measurement was attempted and missed; these lines were never measured at all.
  }

  return out;
}

/**
 * Which of the things this turn's badge can honestly say, in strict order of evidence.
 *
 * THE SENTINEL OUTRANKS THE FALLBACK. `buildTurnAnatomy` already skips `-1` when it picks a
 * sample, so a turn that HAS first-audio samples and still reports `firstAudioMs === null` is a
 * turn whose samples were all the sentinel — an explicit statement that the caller was not
 * waiting. That statement beats any dead-air number that might also be lying around: "he wasn't
 * waiting" and "he waited 900ms" cannot both be true, and the explicit signal is the one to trust.
 *
 * The sentinel is never named here. Deriving it from the fact that the anatomy skipped every
 * sample keeps `-1` private to VOICE, where a change to it stays correct.
 */
function classifyFirstAudio(
  turn: TurnAnatomy,
  from: number,
  to: number,
  metrics: readonly AnatomyMetric[],
): FirstAudio {
  if (turn.firstAudioMs !== null) {
    return { state: 'measured', ms: turn.firstAudioMs, source: STAGE_FIRST_AUDIO };
  }

  const samples = metrics.filter(
    (m) => m.stage === STAGE_FIRST_AUDIO && m.atMs >= from && m.atMs < to,
  );
  if (samples.length > 0 && samples.every((s) => numOrNull(s.durationMs) !== null)) {
    return { state: 'caller_not_waiting' };
  }

  // The other instrument for the same wait. Every report older than the ttsNode probe has this and
  // nothing else, and refusing it would blank the badge on nearly every call on record.
  if (turn.deadAirMs !== null) {
    return { state: 'measured', ms: turn.deadAirMs, source: 'dead_air' };
  }

  return { state: 'not_recorded' };
}

/**
 * The verdict strip: what went right or wrong on this call, each with the number behind it.
 *
 * EVERY READER RETURNS NOTHING WHEN ITS FIELD IS ABSENT, and an absent verdict is omitted from the
 * array rather than rendered as a pass. `callerHungUp` is the case worth holding on to: `false` is
 * a real measurement ("the call reached a deliberate ending") and `undefined` is a report from
 * before that listener shipped, which cannot answer the question at all. Those are different facts
 * and they must not look the same.
 *
 * ORDER IS SET HERE, not in the page. Correctness first, latency last, because `call-report.ts` is
 * explicit that a turn cut in half FINALISES FASTER — a broken call reports the better latency
 * median. Whoever restyles this page next inherits that ordering without having to know why.
 */
export function buildVerdicts(input: {
  summary: Record<string, unknown>;
  compliance: Record<string, unknown> | null;
  toolCalls: ReportToolCall[] | null;
  endReason?: unknown;
}): Verdict[] {
  const { summary, compliance, toolCalls, endReason } = input;
  const out: Verdict[] = [];

  /** A counter whose good value is zero. An absent key produces no verdict at all. */
  const counter = (id: VerdictId, key: string, detail?: Verdict['detail']): void => {
    const n = numOrNull(summary[key]);
    if (n === null) return;
    out.push({
      id,
      status: n > 0 ? 'fail' : 'pass',
      value: n,
      unit: 'count',
      ...(detail === undefined ? {} : { detail }),
    });
  };

  // An empty reasons list is not a reason. Attaching `reasons: ''` puts a label on the card with
  // nothing after it, which reads as a value that failed to load.
  const leakReasons = (asArray(summary.toolCallLeakReasons) ?? []).filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  const restarted = numOrNull(summary.restartedReplies);

  counter('cut_offs', 'cutOffs');
  counter('fragmented_turns', 'fragmentedTurns');
  counter(
    'duplicate_replies',
    'duplicateReplies',
    restarted === null ? undefined : { restartedReplies: restarted },
  );
  counter(
    'tool_call_leaks',
    'toolCallLeaks',
    leakReasons.length === 0 ? undefined : { reasons: leakReasons.join(', ') },
  );
  counter('false_booking_claims', 'falseBookingClaims');

  // Compliance. 'disabled' is an intentional skip and warns; a silent failure to play is a breach.
  const noticePlayed = boolOrNull(compliance?.recording_notice_played);
  if (noticePlayed !== null) {
    const status = strOrNull(compliance?.recording_notice_status);
    out.push({
      id: 'recording_notice',
      status: noticePlayed ? 'pass' : status === 'disabled' ? 'warn' : 'fail',
      value: null,
      unit: 'none',
      ...(status === null ? {} : { detail: { status } }),
    });
  }
  const disclosure = strOrNull(compliance?.ai_disclosure);
  if (disclosure !== null) {
    out.push({
      id: 'ai_disclosure',
      status: disclosure === 'during_call' ? 'pass' : disclosure === 'at_end' ? 'warn' : 'fail',
      value: null,
      unit: 'none',
      detail: { when: disclosure },
    });
  }

  // Tools. A missing array means the report never carried one; an EMPTY array means no tool ran,
  // which is a measurement, and passes.
  if (toolCalls !== null) {
    const failed = toolCalls.filter((t) => t.ok === false).length;
    out.push({
      id: 'tool_failures',
      status: failed > 0 ? 'fail' : 'pass',
      value: failed,
      unit: 'count',
    });
    const slow = toolCalls.filter(
      (t) => t.ok !== false && t.durationMs !== null && t.durationMs > TOOL_BUDGET_MS,
    ).length;
    out.push({
      id: 'tool_budget',
      status: slow > 0 ? 'warn' : 'pass',
      value: slow,
      unit: 'count',
      detail: { budgetMs: TOOL_BUDGET_MS },
    });
  }

  const hungUp = boolOrNull(summary.callerHungUp);
  if (hungUp !== null) {
    const stage = strOrNull(summary.hungUpAtStage);
    out.push({
      id: 'caller_hung_up',
      status: hungUp ? 'fail' : 'pass',
      value: null,
      unit: 'none',
      ...(stage === null ? {} : { detail: { stage } }),
    });
  }

  // Dead air last, and never a pass on a handful of samples: a median over three turns describes
  // nothing, and the whole reason latency-anatomy.ts exists is that pooled medians flatter.
  const deadAir = asObject(summary.deadAir);
  const median = numOrNull(deadAir?.medianMs);
  if (median !== null) {
    const samples = numOrNull(deadAir?.samples) ?? 0;
    out.push({
      id: 'dead_air_budget',
      status:
        median >= DEAD_AIR_BUDGET_MS ? 'fail' : samples < DEAD_AIR_MIN_SAMPLES ? 'warn' : 'pass',
      value: median,
      unit: 'ms',
      detail: { samples, budgetMs: DEAD_AIR_BUDGET_MS },
    });
  }

  const reason = strOrNull(endReason);
  if (reason !== null) {
    out.push({
      id: 'booking_outcome',
      status: reason === 'meeting_booked' ? 'pass' : 'warn',
      value: null,
      unit: 'none',
      detail: { reason },
    });
  }

  return out;
}
