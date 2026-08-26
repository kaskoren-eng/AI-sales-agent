import { describe, expect, it } from 'vitest';
import { assembleVoiceMetrics, type VoiceMetricsRaw } from './metrics.service.js';

/** A raw result set with everything empty — each test overrides only the part it cares about. */
function raw(over: Partial<VoiceMetricsRaw> = {}): VoiceMetricsRaw {
  const to = new Date('2026-08-26T12:00:00.000Z');
  return {
    range: 'today',
    from: new Date('2026-08-26T00:00:00.000Z'),
    to,
    days: 1,
    seriesDays: 7,
    counters: {
      total: 0,
      failed: 0,
      totalDurationSecs: 0,
      avgDurationSecs: null,
      disclosureMissed: 0,
      fragmentedTurnCalls: 0,
      fragmentedTurnsTotal: 0,
      cutOffsTotal: 0,
    },
    endReasonRows: [],
    latencyRow: {
      callsWithLatency: 0,
      eouMedian: null,
      eouP95: null,
      ttftMedian: null,
      ttftP95: null,
      ttfbMedian: null,
      ttfbP95: null,
      worstMedian: null,
      worstP95: null,
      worstMax: null,
    },
    overBudgetToolCalls: 0,
    seriesRows: [],
    openPeriod: null,
    ...over,
  };
}

describe('booking rate — the denominator is calls that recorded a reason', () => {
  it('3 booked of 10 measured calls is 30%', () => {
    const m = assembleVoiceMetrics(
      raw({
        endReasonRows: [
          { reason: 'meeting_booked', c: 3 },
          { reason: 'not_interested', c: 5 },
          { reason: 'not_qualified', c: 2 },
        ],
      }),
    );
    expect(m.outcomes.withEndReason).toBe(10);
    expect(m.outcomes.booked).toBe(3);
    expect(m.outcomes.bookingRatePct).toBe(30);
  });

  it('NULL when nothing was measured — "none closed" and "none measured" are different facts', () => {
    expect(assembleVoiceMetrics(raw()).outcomes.bookingRatePct).toBeNull();
    // Calls exist, but none reached a deliberate end_call: still null, never 0%.
    const m = assembleVoiceMetrics(raw({ endReasonRows: [{ reason: null, c: 4 }] }));
    expect(m.outcomes.bookingRatePct).toBeNull();
    expect(m.outcomes.withEndReason).toBe(0);
  });

  it('reasonless calls stay VISIBLE as `unknown` and out of the denominator', () => {
    const m = assembleVoiceMetrics(
      raw({
        endReasonRows: [
          { reason: 'meeting_booked', c: 1 },
          { reason: null, c: 9 },
        ],
      }),
    );
    expect(m.outcomes.byEndReason).toEqual({ meeting_booked: 1, unknown: 9 });
    expect(m.outcomes.bookingRatePct).toBe(100); // 1 of 1 measured — with 9 unknowns on show
  });
});

describe('latency', () => {
  it('no instrumented calls → every figure null and callsWithLatency 0 (drives "awaiting data")', () => {
    const m = assembleVoiceMetrics(raw({ counters: { ...raw().counters, total: 12 } }));
    expect(m.latency.callsWithLatency).toBe(0);
    expect(m.latency.endOfTurnMs).toEqual({ median: null, p95: null });
    expect(m.latency.worstCaseMs).toEqual({ median: null, p95: null, max: null });
  });

  it('rounds percentiles to whole milliseconds', () => {
    const m = assembleVoiceMetrics(
      raw({
        latencyRow: {
          ...raw().latencyRow,
          callsWithLatency: 5,
          eouMedian: 512.4,
          eouP95: 880.6,
          worstMedian: 1240.5,
          worstMax: 2178.9,
        },
      }),
    );
    expect(m.latency.endOfTurnMs).toEqual({ median: 512, p95: 881 });
    expect(m.latency.worstCaseMs.median).toBe(1241);
    expect(m.latency.worstCaseMs.max).toBe(2179);
  });

  it('a stage nobody recorded stays null while the others report', () => {
    const m = assembleVoiceMetrics(
      raw({ latencyRow: { ...raw().latencyRow, callsWithLatency: 2, eouMedian: 400, ttfbMedian: 200 } }),
    );
    expect(m.latency.endOfTurnMs.median).toBe(400);
    expect(m.latency.llmTtftMs.median).toBeNull();
  });
});

describe('usage — minutes only, never our provider cost', () => {
  it('90 seconds is 1.5 minutes', () => {
    const m = assembleVoiceMetrics(raw({ counters: { ...raw().counters, totalDurationSecs: 90 } }));
    expect(m.usage.minutes).toBe(1.5);
  });

  it('serves NO money field to a tenant — cost is margin data, operator-only', () => {
    const m = assembleVoiceMetrics(raw({ counters: { ...raw().counters, totalDurationSecs: 600 } }));
    expect(m.usage).toEqual({ minutes: 10 });
    // Guards the leak this endpoint used to have: minutes × the toll-fraud rate, served as
    // "estimated cost" to anyone holding a tenant API key.
    const serialized = JSON.stringify(m);
    for (const leaked of ['perMinuteRateUsd', 'estimatedUsd', 'estimated', 'cost']) {
      expect(serialized).not.toContain(leaked);
    }
  });
});

describe('bundle — what the customer bought and what they have spent', () => {
  const period = (over: Partial<NonNullable<VoiceMetricsRaw['openPeriod']>> = {}) => ({
    openPeriod: {
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      includedMinutes: 300,
      overagePerMinuteAgorot: 300,
      secondsUsed: 0,
      ...over,
    },
  });

  it('inside the bundle there is no overage and nothing to pay', () => {
    const m = assembleVoiceMetrics(raw(period({ secondsUsed: 6000 }))); // 100 min
    expect(m.bundle).toMatchObject({ includedMinutes: 300, minutesUsed: 100, overageMinutes: 0, estimatedOverageAgorot: 0 });
  });

  it('past the bundle, only the minutes BEYOND it are charged', () => {
    const m = assembleVoiceMetrics(raw(period({ secondsUsed: 19_800 }))); // 330 min
    expect(m.bundle).toMatchObject({ minutesUsed: 330, overageMinutes: 30, estimatedOverageAgorot: 30 * 300 });
  });

  it('rounds the PERIOD once, not every call — a part-minute is one minute, not one per call', () => {
    // 200 calls of 30s is 100 minutes of talk time. Rounding per call would bill 200.
    const m = assembleVoiceMetrics(raw(period({ secondsUsed: 200 * 30 })));
    expect(m.bundle!.minutesUsed).toBe(100);
    // And any part-minute still counts as a whole one at the period level.
    expect(assembleVoiceMetrics(raw(period({ secondsUsed: 61 }))).bundle!.minutesUsed).toBe(2);
  });

  it('an unmetered plan has NO bundle — not a bundle of zero', () => {
    // null allowance = bespoke/internal. Zero would render as "you have used all of nothing".
    expect(assembleVoiceMetrics(raw(period({ includedMinutes: null }))).bundle).toBeNull();
  });

  it('no open period yet means no bundle', () => {
    expect(assembleVoiceMetrics(raw()).bundle).toBeNull();
  });

  it('the bundle is period-scoped and ignores the range selector', () => {
    // usage.minutes follows the range; the allowance follows the billing period. Different windows.
    const m = assembleVoiceMetrics(
      raw({ ...period({ secondsUsed: 18_000 }), counters: { ...raw().counters, totalDurationSecs: 600 } }),
    );
    expect(m.usage.minutes).toBe(10); // 600s in the selected range
    expect(m.bundle!.minutesUsed).toBe(300); // 18000s across the period
  });
});

describe('series', () => {
  it('zero-fills every bucket so the chart is a line, not a dot', () => {
    const m = assembleVoiceMetrics(
      raw({ seriesRows: [{ d: '2026-08-22', calls: 3, durationSecs: 180, booked: 1 }] }),
    );
    expect(m.series).toHaveLength(7);
    expect(m.series[0]).toEqual({ date: '2026-08-20', calls: 0, minutes: 0, booked: 0 });
    expect(m.series[2]).toEqual({ date: '2026-08-22', calls: 3, minutes: 3, booked: 1 });
  });

  it("ENDS ON TODAY — buckets are UTC days, so today's calls can't fall off the chart", () => {
    // Regression: walking the days in local time shifted every key a day earlier east of
    // Greenwich, and the newest bucket silently vanished. Today must be the last bucket, and
    // every call the counters saw must land in one.
    const m = assembleVoiceMetrics(
      raw({ seriesRows: [{ d: '2026-08-26', calls: 3, durationSecs: 240, booked: 1 }] }),
    );
    expect(m.series.at(-1)).toEqual({ date: '2026-08-26', calls: 3, minutes: 4, booked: 1 });
    expect(m.series.reduce((n, s) => n + s.calls, 0)).toBe(3);
  });
});

describe('attention signals', () => {
  it('passes the compliance and speech-quality counters straight through', () => {
    const m = assembleVoiceMetrics(
      raw({
        counters: {
          ...raw().counters,
          total: 20,
          failed: 2,
          disclosureMissed: 1,
          fragmentedTurnCalls: 3,
          fragmentedTurnsTotal: 7,
          cutOffsTotal: 4,
        },
        overBudgetToolCalls: 5,
      }),
    );
    expect(m.attention).toEqual({
      failedCalls: 2,
      disclosureMissed: 1,
      fragmentedTurnCalls: 3,
      fragmentedTurnsTotal: 7,
      cutOffsTotal: 4,
      overBudgetToolCalls: 5,
    });
    expect(m.calls).toMatchObject({ total: 20, failed: 2 });
  });
});
