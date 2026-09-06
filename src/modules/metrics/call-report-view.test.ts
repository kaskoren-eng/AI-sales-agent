/**
 * The contract these tests exist to hold: the page never shows a number the call did not produce.
 *
 * Most of them are about the difference between three things that a careless renderer collapses
 * into one — a field that was never measured, a field measured as zero, and a field measured as
 * something. The repo has shipped several instruments whose failure mode was returning a
 * comfortable number instead of nothing, so each of those distinctions gets its own test.
 */
import { describe, it, expect } from 'vitest';
import { summarizeLatency } from '../channels/voice-livekit/latency-anatomy.js';
import {
  buildCallReportView,
  buildVerdicts,
  type CallReportView,
  type ReportTranscriptLine,
} from './call-report-view.js';

/** An end-of-turn boundary — the event that opens a caller turn. */
const eou = (atMs: number, delay = 400) => ({
  atMs,
  stage: 'eou_metrics',
  endOfUtteranceDelayMs: delay,
});
/** A first-audio sample. `-1` is the sentinel meaning the caller was not waiting. */
const firstAudio = (atMs: number, durationMs: number) => ({
  atMs,
  stage: 'first_audio_frame',
  durationMs,
});

const line = (
  atMs: number,
  role: string,
  text: string,
  spokeAtMs?: number,
): Record<string, unknown> => ({
  atMs,
  role,
  text,
  ...(spokeAtMs === undefined ? {} : { spokeAtMs }),
});

/** Two caller turns plus the greeting, with one measured reply each. */
function twoTurnReport(): Record<string, unknown> {
  return {
    room: 'room-1',
    startedAt: '2026-09-06T12:00:00.000Z',
    durationSec: 42,
    summary: { turnsHeard: 2 },
    metrics: [
      firstAudio(100, -1), // the greeting: nobody was waiting for it
      eou(1000),
      firstAudio(1200, 900),
      eou(5000),
      firstAudio(5300, 1500),
    ],
    transcript: [
      line(200, 'assistant', 'greeting', 150),
      line(900, 'user', 'hello'),
      line(2000, 'assistant', 'her first reply', 1200),
      line(4900, 'user', 'a question'),
      line(6000, 'assistant', 'her second reply', 5300),
    ],
  };
}

function badgedLines(view: CallReportView): ReportTranscriptLine[] {
  return view.transcript.filter((l) => l.firstAudio !== null);
}

describe('buildCallReportView', () => {
  it('returns null rather than throwing for anything that is not a report object', () => {
    for (const input of [null, undefined, 'a string', [], 42, true, NaN]) {
      expect(buildCallReportView(input)).toBeNull();
    }
  });

  it('recomputes the turns from metrics so old and new reports read the same way', () => {
    const view = buildCallReportView(twoTurnReport())!;
    expect(view.turnsSource).toBe('derived');
    // The greeting is turn 0, so two end-of-turn boundaries make three windows.
    expect(view.turns).toHaveLength(3);
    expect(view.turnsDetected).toBe(true);
  });

  it('falls back to the stored turns when a report carries no metrics array', () => {
    const view = buildCallReportView({
      summary: {},
      turns: [{ index: 0, atMs: 0, firstAudioMs: null }],
    })!;
    expect(view.turnsSource).toBe('report');
    expect(view.turns).toHaveLength(1);
  });

  it('says it has nothing rather than inventing a turn when the report carries neither', () => {
    const view = buildCallReportView({ summary: {}, transcript: [line(0, 'assistant', 'hi')] })!;
    expect(view.turnsSource).toBe('none');
    expect(view.latency).toBeNull();
    expect(view.turnsDetected).toBe(false);
    expect(badgedLines(view)).toHaveLength(0);
  });

  it('carries a summary key it has never heard of straight through to the page', () => {
    // The whole point of passing `summary` verbatim: the day VOICE adds a counter, it shows up
    // here with no dashboard change. An allowlist would silently swallow it.
    const view = buildCallReportView({ summary: { someFutureCounter: 7, cutOffs: 0 } })!;
    expect(view.raw.summary.someFutureCounter).toBe(7);
  });

  it('keeps the report figures and the recomputed ones side by side instead of merging them', () => {
    const report = twoTurnReport();
    (report.summary as Record<string, unknown>).latency = { turns: 99 };
    const view = buildCallReportView(report)!;
    expect(view.latencyFromReport).toEqual({ turns: 99 });
    expect(view.latency!.turns).toBe(2); // recomputed, and the greeting is not one of them
  });

  it('drops tool-call args, which the page has no use for and a browser should not receive', () => {
    const view = buildCallReportView({
      summary: {},
      toolCalls: [{ atMs: 10, name: 'book_meeting', durationMs: 120, ok: true, args: { phone: '05x' } }],
    })!;
    expect(view.toolCalls).toHaveLength(1);
    expect(view.toolCalls![0]).not.toHaveProperty('args');
    expect(JSON.stringify(view.toolCalls)).not.toContain('05x');
  });
});

describe('the per-turn latency badge', () => {
  it('puts exactly one badge per turn, on the line that actually made the sound', () => {
    const view = buildCallReportView(twoTurnReport())!;
    const badged = badgedLines(view);
    expect(badged).toHaveLength(3);
    expect(badged.map((l) => l.text)).toEqual(['greeting', 'her first reply', 'her second reply']);
    expect(badged[1]!.firstAudio).toEqual({ state: 'measured', ms: 900 });
  });

  it('leaves a continuation line in the same turn unbadged rather than repeating the number', () => {
    const report = twoTurnReport();
    (report.transcript as unknown[]).push(line(2500, 'assistant', 'she carried on', 2400));
    const view = buildCallReportView(report)!;
    const inTurnOne = view.transcript.filter((l) => l.turnIndex === 1 && l.role === 'assistant');
    expect(inTurnOne).toHaveLength(2);
    expect(inTurnOne.filter((l) => l.firstAudio !== null)).toHaveLength(1);
    expect(inTurnOne.find((l) => l.text === 'she carried on')!.firstAudio).toBeNull();
  });

  it('never badges a caller line', () => {
    const view = buildCallReportView(twoTurnReport())!;
    expect(view.transcript.filter((l) => l.role === 'user' && l.firstAudio !== null)).toHaveLength(0);
  });

  it('reads -1 as "the caller was not waiting", never as a measurement', () => {
    const view = buildCallReportView(twoTurnReport())!;
    // The greeting: her audio started before anyone had spoken to her.
    expect(view.transcript.find((l) => l.text === 'greeting')!.firstAudio).toEqual({
      state: 'caller_not_waiting',
    });
  });

  it('keeps the sentinel out of the latency percentiles', () => {
    const view = buildCallReportView(twoTurnReport())!;
    const stats = summarizeLatency(view.turns).all;
    // 900 and 1500 are the only real waits; the greeting's -1 is neither averaged nor floored to 0.
    expect(stats.firstAudioP50).toBe(900);
    expect(view.turns[0]!.firstAudioMs).toBeNull();
  });

  it('treats a measured zero as a measurement, not as an absence', () => {
    const report = {
      summary: {},
      metrics: [eou(1000), firstAudio(1100, 0)],
      transcript: [line(1500, 'assistant', 'instant', 1100)],
    };
    const view = buildCallReportView(report)!;
    expect(view.transcript[0]!.firstAudio).toEqual({ state: 'measured', ms: 0 });
  });

  it('says "not recorded" when the build wrote no first-audio sample for the turn', () => {
    const report = {
      summary: {},
      metrics: [eou(1000)],
      transcript: [line(1500, 'assistant', 'no sample exists', 1100)],
    };
    const view = buildCallReportView(report)!;
    expect(view.transcript[0]!.firstAudio).toEqual({ state: 'not_recorded' });
  });

  it('gives a line landing exactly on a boundary to the turn that boundary opens', () => {
    const report = {
      summary: {},
      metrics: [eou(1000), eou(2000)],
      transcript: [line(2000, 'assistant', 'on the boundary', 2000)],
    };
    const view = buildCallReportView(report)!;
    expect(view.transcript[0]!.turnIndex).toBe(2);
  });

  it('places her line by when she spoke, not by when the SDK committed it', () => {
    // The SDK commits an assistant message at the END of playout, so a long reply commits after
    // the next end-of-turn. Placing by `atMs` would file it under the turn it answered next.
    const report = {
      summary: {},
      metrics: [eou(1000), firstAudio(1100, 700), eou(9000)],
      transcript: [line(9500, 'assistant', 'a long reply', 1100)],
    };
    const view = buildCallReportView(report)!;
    expect(view.transcript[0]!.turnIndex).toBe(1);
    expect(view.transcript[0]!.firstAudio).toEqual({ state: 'measured', ms: 700 });
  });

  it('does not let a silent tool step take the badge off the line that made the sound', () => {
    const report = {
      summary: {},
      metrics: [eou(1000), firstAudio(1400, 800)],
      transcript: [
        line(1100, 'assistant', 'tool-only step, no audio'),
        line(2000, 'assistant', 'the reply she spoke', 1400),
      ],
    };
    const view = buildCallReportView(report)!;
    expect(view.transcript[0]!.firstAudio).toBeNull();
    expect(view.transcript[1]!.firstAudio).toEqual({ state: 'measured', ms: 800 });
  });

  it('suppresses every badge when no end-of-turn event was found at all', () => {
    // A stage rename in VOICE lands here. One window would cover the whole call, and badging off
    // it would print the greeting's number against every reply she made.
    const report = {
      summary: {},
      metrics: [{ atMs: 100, stage: 'renamed_by_voice', endOfUtteranceDelayMs: 300 }],
      transcript: [line(200, 'assistant', 'hi', 150), line(900, 'assistant', 'again', 800)],
    };
    const view = buildCallReportView(report)!;
    expect(view.turnsDetected).toBe(false);
    expect(badgedLines(view)).toHaveLength(0);
  });
});

describe('verdicts', () => {
  const only = (v: ReturnType<typeof buildVerdicts>, id: string) => v.find((x) => x.id === id);

  it('omits a counter the report never carried instead of calling it a pass', () => {
    const v = buildVerdicts({ summary: {}, compliance: null, toolCalls: null });
    expect(only(v, 'cut_offs')).toBeUndefined();
  });

  it('reports a measured zero as a pass, with the zero attached', () => {
    const v = buildVerdicts({ summary: { cutOffs: 0 }, compliance: null, toolCalls: null });
    expect(only(v, 'cut_offs')).toMatchObject({ status: 'pass', value: 0 });
  });

  it('fails a counter that actually counted something', () => {
    const v = buildVerdicts({ summary: { cutOffs: 3 }, compliance: null, toolCalls: null });
    expect(only(v, 'cut_offs')).toMatchObject({ status: 'fail', value: 3 });
  });

  it('tells "he did not hang up" apart from "this build could not tell"', () => {
    const measured = buildVerdicts({
      summary: { callerHungUp: false },
      compliance: null,
      toolCalls: null,
    });
    expect(only(measured, 'caller_hung_up')).toMatchObject({ status: 'pass' });

    const unmeasured = buildVerdicts({ summary: {}, compliance: null, toolCalls: null });
    expect(only(unmeasured, 'caller_hung_up')).toBeUndefined();
  });

  it('distinguishes a report with no tool array from a call where no tool ran', () => {
    const absent = buildVerdicts({ summary: {}, compliance: null, toolCalls: null });
    expect(only(absent, 'tool_failures')).toBeUndefined();

    const none = buildVerdicts({ summary: {}, compliance: null, toolCalls: [] });
    expect(only(none, 'tool_failures')).toMatchObject({ status: 'pass', value: 0 });
  });

  it('warns on a dead-air median drawn from too few turns to mean anything', () => {
    const v = buildVerdicts({
      summary: { deadAir: { medianMs: 800, samples: 3 } },
      compliance: null,
      toolCalls: null,
    });
    expect(only(v, 'dead_air_budget')).toMatchObject({ status: 'warn', value: 800 });
  });

  it('passes a dead-air median that is both under budget and actually sampled', () => {
    const v = buildVerdicts({
      summary: { deadAir: { medianMs: 800, samples: 12 } },
      compliance: null,
      toolCalls: null,
    });
    expect(only(v, 'dead_air_budget')).toMatchObject({ status: 'pass' });
  });

  it('warns rather than fails when the recording notice was deliberately switched off', () => {
    const v = buildVerdicts({
      summary: {},
      compliance: { recording_notice_played: false, recording_notice_status: 'disabled' },
      toolCalls: null,
    });
    expect(only(v, 'recording_notice')).toMatchObject({ status: 'warn' });
  });

  it('fails a recording notice that was meant to play and did not', () => {
    const v = buildVerdicts({
      summary: {},
      compliance: { recording_notice_played: false, recording_notice_status: 'failed' },
      toolCalls: null,
    });
    expect(only(v, 'recording_notice')).toMatchObject({ status: 'fail' });
  });

  it('orders correctness above latency, because a call cut short reports a better median', () => {
    const v = buildVerdicts({
      summary: { cutOffs: 2, deadAir: { medianMs: 500, samples: 20 } },
      compliance: null,
      toolCalls: null,
    });
    const ids = v.map((x) => x.id);
    expect(ids.indexOf('cut_offs')).toBeLessThan(ids.indexOf('dead_air_budget'));
  });
});
