import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallReport } from './call-report.js';

/**
 * The dead-air stopwatch — the instrument we now steer latency by, so it gets tests.
 *
 * WHY THIS METRIC EXISTS. The report already carried `worstCaseMs`: end-of-turn + LLM + TTS
 * medians, added up. It reported 1466ms for a call whose real median silence was 2535ms, because
 * it is a sum of three medians that never co-occurred on one turn AND it is blind to preemptive
 * generation — the mechanism that decides the answer, since its whole job is to move the LLM and
 * TTS inside the end-of-turn wait. We spent a session optimising against an instrument that could
 * not see the thing being optimised. A wrong instrument is worse than none, so this one is pinned.
 */
const CONFIG = {
  sttProvider: 'soniox',
  sttModel: 'stt-rt-v5',
  turnDetection: 'stt',
  llmModel: 'gpt-5.4',
  ttsModel: 'sonic-3.5',
};

const newReport = () => new CallReport('call-test', '+972500000000', CONFIG);

describe('CallReport dead air', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('measures the silence between the caller stopping and the agent speaking', () => {
    const report = newReport();
    report.noteUserStartedSpeaking();
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(850);
    report.noteAgentStartedSpeaking();

    const { deadAir } = report.toJson().summary;
    expect(deadAir.samples).toBe(1);
    expect(deadAir.medianMs).toBe(850);
  });

  it('measures from the LAST stop when the turn detector shreds one sentence', () => {
    const report = newReport();
    // "אני." … "עונה לכולם." … "כמה שעות" — one thought, three turns, as happened on 2026-08-16.
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(3_000);
    report.noteUserStartedSpeaking();
    vi.advanceTimersByTime(500);
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(600);
    report.noteAgentStartedSpeaking();

    // 600, not 4100: the caller's own thinking pause is not the agent being slow.
    expect(report.toJson().summary.deadAir.medianMs).toBe(600);
  });

  it('scores one wait per reply, not one per audio segment', () => {
    const report = newReport();
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(700);
    report.noteAgentStartedSpeaking(); // first sentence
    vi.advanceTimersByTime(80);
    report.noteAgentStartedSpeaking(); // rest of the same answer — no new silence to measure

    const { deadAir } = report.toJson().summary;
    expect(deadAir.samples).toBe(1);
    expect(deadAir.maxMs).toBe(700);
  });

  it('ignores the greeting, which answers no one', () => {
    const report = newReport();
    report.noteAgentStartedSpeaking();

    expect(report.toJson().summary.deadAir.samples).toBe(0);
  });

  it('reports p90 as well as the median — the worst turns are what the caller remembers', () => {
    const report = newReport();
    for (const ms of [200, 250, 300, 350, 400, 450, 500, 600, 2_000, 6_000]) {
      report.noteUserStoppedSpeaking();
      vi.advanceTimersByTime(ms);
      report.noteAgentStartedSpeaking();
    }

    const { deadAir } = report.toJson().summary;
    expect(deadAir.samples).toBe(10);
    expect(deadAir.medianMs).toBe(425);
    // A median of 425ms would read as a solved problem. It is not: one turn in ten took 6s.
    expect(deadAir.p90Ms).toBe(2_000);
    expect(deadAir.maxMs).toBe(6_000);
  });

  it('reports nulls rather than a fabricated zero when nothing was measured', () => {
    const { deadAir } = newReport().toJson().summary;

    expect(deadAir).toEqual({ medianMs: null, p90Ms: null, minMs: null, maxMs: null, samples: 0 });
  });
});
