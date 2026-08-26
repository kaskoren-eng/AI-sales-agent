import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leads, callLearnings, usagePeriods } from '../../db/schema/index.js';

export type MetricsRange = 'today' | 'd7' | 'd30';

export interface MetricsSummary {
  range: MetricsRange;
  from: string;
  to: string;
  days: number;
  kpis: {
    leadsTotal: number;
    qualified: number;
    booked: number;
    callsTotal: number;
    callsInRange: number;
    /** Average GPT effectiveness score (0–100) across analyzed calls, or null if none analyzed. */
    qualityScore: number | null;
  };
  /** Lead counts by status (drives the pipeline strip) — measured, all-time. */
  pipeline: Record<string, number>;
  /** Daily buckets for the trend chart (>= 7 days so the chart is never a single point). */
  series: Array<{ date: string; leads: number; calls: number }>;
}

/**
 * Voice-agent supervision metrics — what a manager needs to see about the agent's calls.
 *
 * Reads two columns, and the split matters. The latency/health figures come from `call_report`,
 * where the agent writes its CallReport verbatim at call end; the outcome and compliance figures
 * come from `analysis`. They are deliberately NOT in the same place: the GPT call-analysis worker
 * rewrites `analysis` after the fact and would wipe a report nested inside it.
 *
 * Aggregated on `call_learnings` DIRECTLY, not through `conversations`: a LiveKit call has no
 * conversations row of its own, so anything built on the calls list would under-report.
 *
 * And never filtered on `status = 'analyzed'` — LiveKit rows are inserted 'pending' and, with no
 * recording to transcribe, most stay that way. Filtering on analyzed hides the agent's own calls.
 */
export interface VoiceMetrics {
  range: MetricsRange;
  from: string;
  to: string;
  days: number;
  calls: {
    total: number;
    failed: number;
    totalDurationSecs: number;
    avgDurationSecs: number | null;
  };
  outcomes: {
    /** meeting_booked | not_qualified | not_interested | opt_out | wrong_person | unknown */
    byEndReason: Record<string, number>;
    /** Calls that ended through end_call and therefore recorded a reason. */
    withEndReason: number;
    booked: number;
    /**
     * booked / withEndReason, as a percentage. NULL — not 0 — when nothing recorded a reason:
     * "no calls closed" and "no calls measured" are different facts and must render differently.
     */
    bookingRatePct: number | null;
  };
  latency: {
    /** Calls carrying a CallReport. 0 → the UI shows "awaiting data", not a row of zeroes. */
    callsWithLatency: number;
    endOfTurnMs: { median: number | null; p95: number | null };
    llmTtftMs: { median: number | null; p95: number | null };
    ttsTtfbMs: { median: number | null; p95: number | null };
    worstCaseMs: { median: number | null; p95: number | null; max: number | null };
  };
  attention: {
    failedCalls: number;
    /** ai_disclosure = 'missed' — an audit finding, never a formality. */
    disclosureMissed: number;
    fragmentedTurnCalls: number;
    fragmentedTurnsTotal: number;
    cutOffsTotal: number;
    /** Tool invocations over the 500ms budget. */
    overBudgetToolCalls: number;
  };
  /**
   * Voice minutes used in the range — a USAGE figure the tenant is entitled to see.
   *
   * There is deliberately no money here. What a call costs US in provider fees (tokens, characters,
   * STT seconds) is the margin signal and is operator-only; `db/schema/billing.ts` states the same
   * rule for the same reason — measured cost never reaches an invoice, let alone a tenant's screen.
   * An earlier version of this endpoint returned minutes × the toll-fraud rate as "estimated cost",
   * which published our cost basis to anyone holding a tenant API key.
   */
  usage: { minutes: number };
  /**
   * The tenant's own billing bundle for the CURRENT PERIOD — deliberately not scoped by `range`.
   *
   * Everything else on this page answers "how did the agent do over the last 7 days"; a bundle
   * answers "how much of what I bought have I spent", and that question only has one honest window
   * — the billing period. Showing a 7-day slice of a monthly allowance would read as an allowance
   * that resets weekly.
   *
   * Null when the tenant has no open period yet, or is on an unmetered plan. Money here is what the
   * CUSTOMER owes (their bundle and overage), never what the calls cost us.
   */
  bundle: {
    periodStart: string;
    periodEnd: string;
    includedMinutes: number;
    minutesUsed: number;
    /** Minutes past the bundle, 0 while inside it. */
    overageMinutes: number;
    overagePerMinuteAgorot: number;
    /** overageMinutes × rate, in agorot. Indicative — the invoice is written by hand. */
    estimatedOverageAgorot: number;
  } | null;
  series: Array<{ date: string; calls: number; minutes: number; booked: number }>;
}

/** The raw query rows `voice()` gathers, before shaping. Split out so the shaping is testable. */
export interface VoiceMetricsRaw {
  range: MetricsRange;
  from: Date;
  to: Date;
  days: number;
  seriesDays: number;
  counters: {
    total: number;
    failed: number;
    totalDurationSecs: number;
    avgDurationSecs: number | null;
    disclosureMissed: number;
    fragmentedTurnCalls: number;
    fragmentedTurnsTotal: number;
    cutOffsTotal: number;
  };
  endReasonRows: Array<{ reason: string | null; c: number }>;
  latencyRow: {
    callsWithLatency: number;
    eouMedian: number | null;
    eouP95: number | null;
    ttftMedian: number | null;
    ttftP95: number | null;
    ttfbMedian: number | null;
    ttfbP95: number | null;
    worstMedian: number | null;
    worstP95: number | null;
    worstMax: number | null;
  };
  overBudgetToolCalls: number;
  seriesRows: Array<{ d: string; calls: number; durationSecs: number; booked: number }>;
  openPeriod: {
    periodStart: Date;
    periodEnd: Date;
    includedMinutes: number | null;
    overagePerMinuteAgorot: number;
    secondsUsed: number;
  } | null;
}

const round = (v: unknown, dp = 0): number | null => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Pure shaping of the query results — no DB, so the arithmetic is unit-testable on its own. */
export function assembleVoiceMetrics(raw: VoiceMetricsRaw): VoiceMetrics {
  const { counters, latencyRow } = raw;

  // End reasons. A NULL reason is its own visible bucket: those calls never reached a deliberate
  // end_call (crash, caller hangup, or a row written before this was instrumented). They are
  // excluded from the booking-rate denominator but never hidden.
  const byEndReason: Record<string, number> = {};
  let withEndReason = 0;
  for (const row of raw.endReasonRows) {
    const c = Number(row.c);
    if (row.reason == null) {
      byEndReason['unknown'] = (byEndReason['unknown'] ?? 0) + c;
    } else {
      byEndReason[row.reason] = (byEndReason[row.reason] ?? 0) + c;
      withEndReason += c;
    }
  }
  const booked = byEndReason['meeting_booked'] ?? 0;
  const bookingRatePct = withEndReason === 0 ? null : round((booked / withEndReason) * 100, 1);

  const minutes = round(counters.totalDurationSecs / 60, 1) ?? 0;

  // The bundle. A null allowance means unmetered (bespoke or internal) — there is nothing to spend
  // down, so there is nothing to show, which is different from having spent zero.
  const p = raw.openPeriod;
  let bundle: VoiceMetrics['bundle'] = null;
  if (p && p.includedMinutes != null) {
    // Round the period total ONCE, here, rather than per call — rounding each call up to a whole
    // minute would overstate a busy month by roughly the number of calls in it.
    const minutesUsed = Math.ceil(p.secondsUsed / 60);
    const overageMinutes = Math.max(0, minutesUsed - p.includedMinutes);
    bundle = {
      periodStart: p.periodStart.toISOString(),
      periodEnd: p.periodEnd.toISOString(),
      includedMinutes: p.includedMinutes,
      minutesUsed,
      overageMinutes,
      overagePerMinuteAgorot: p.overagePerMinuteAgorot,
      estimatedOverageAgorot: overageMinutes * p.overagePerMinuteAgorot,
    };
  }

  // Zero-filled daily buckets, same shape as summary()'s trend so both charts line up.
  const byDay = new Map(raw.seriesRows.map((r) => [r.d, r]));
  const series: VoiceMetrics['series'] = utcDayBuckets(raw.to, raw.seriesDays).keys.map((key) => {
    const row = byDay.get(key);
    return {
      date: key,
      calls: Number(row?.calls ?? 0),
      minutes: round(Number(row?.durationSecs ?? 0) / 60, 1) ?? 0,
      booked: Number(row?.booked ?? 0),
    };
  });

  return {
    range: raw.range,
    from: raw.from.toISOString(),
    to: raw.to.toISOString(),
    days: raw.days,
    calls: {
      total: counters.total,
      failed: counters.failed,
      totalDurationSecs: counters.totalDurationSecs,
      avgDurationSecs: round(counters.avgDurationSecs),
    },
    outcomes: { byEndReason, withEndReason, booked, bookingRatePct },
    latency: {
      callsWithLatency: latencyRow.callsWithLatency,
      endOfTurnMs: { median: round(latencyRow.eouMedian), p95: round(latencyRow.eouP95) },
      llmTtftMs: { median: round(latencyRow.ttftMedian), p95: round(latencyRow.ttftP95) },
      ttsTtfbMs: { median: round(latencyRow.ttfbMedian), p95: round(latencyRow.ttfbP95) },
      worstCaseMs: {
        median: round(latencyRow.worstMedian),
        p95: round(latencyRow.worstP95),
        max: round(latencyRow.worstMax),
      },
    },
    attention: {
      failedCalls: counters.failed,
      disclosureMissed: counters.disclosureMissed,
      fragmentedTurnCalls: counters.fragmentedTurnCalls,
      fragmentedTurnsTotal: counters.fragmentedTurnsTotal,
      cutOffsTotal: counters.cutOffsTotal,
      overBudgetToolCalls: raw.overBudgetToolCalls,
    },
    usage: { minutes },
    bundle,
    series,
  };
}

function windowFor(range: MetricsRange): { from: Date; to: Date; days: number } {
  const to = new Date();
  const from = new Date(to);
  if (range === 'today') {
    from.setHours(0, 0, 0, 0);
    return { from, to, days: 1 };
  }
  const days = range === 'd7' ? 7 : 30;
  from.setDate(from.getDate() - days);
  return { from, to, days };
}

/** YYYY-MM-DD in UTC — matches Postgres `::date::text` so buckets line up. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The chart's day buckets, ending on TODAY, keyed the way the SQL groups them.
 *
 * Must be built in UTC. The queries bucket on `(created_at at time zone 'utc')::date`, and `dayKey`
 * reads a UTC date back out — so walking the days in local time silently shifts every key one day
 * earlier east of Greenwich, and the newest bucket (today's calls) falls off the end of the chart.
 */
function utcDayBuckets(to: Date, count: number): { start: Date; keys: string[] } {
  const start = new Date(to);
  start.setUTCDate(start.getUTCDate() - (count - 1));
  start.setUTCHours(0, 0, 0, 0);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    keys.push(dayKey(d));
  }
  return { start, keys };
}

export class MetricsService {
  constructor(private db: Database) {}

  async summary(tenantId: string, range: MetricsRange): Promise<MetricsSummary> {
    const { from, to, days } = windowFor(range);

    // Chart trend: at least 7 daily buckets even for "today", so it renders as a line, not a dot.
    const seriesDays = Math.max(days, 7);
    const seriesFrom = utcDayBuckets(to, seriesDays).start;

    const leadDay = sql<string>`(${leads.createdAt} at time zone 'utc')::date::text`;
    const callDay = sql<string>`(${callLearnings.createdAt} at time zone 'utc')::date::text`;

    const [pipelineRows, callsTotalRow, callsRangeRow, qualityRow, leadSeries, callSeries] = await Promise.all([
      // Lead counts by status (all-time) → pipeline + leadsTotal + qualified + booked.
      this.db.select({ status: leads.status, c: count() }).from(leads).where(eq(leads.tenantId, tenantId)).groupBy(leads.status),
      this.db.select({ c: count() }).from(callLearnings).where(eq(callLearnings.tenantId, tenantId)),
      this.db.select({ c: count() }).from(callLearnings).where(and(eq(callLearnings.tenantId, tenantId), gte(callLearnings.createdAt, from))),
      // Average effectiveness score across analyzed calls (jsonb → numeric). null-safe.
      this.db
        .select({ avg: sql<number | null>`avg((${callLearnings.analysis} ->> 'overall_effectiveness_score')::float)` })
        .from(callLearnings)
        .where(and(eq(callLearnings.tenantId, tenantId), eq(callLearnings.status, 'analyzed'))),
      this.db.select({ d: leadDay, c: count() }).from(leads).where(and(eq(leads.tenantId, tenantId), gte(leads.createdAt, seriesFrom))).groupBy(leadDay),
      this.db.select({ d: callDay, c: count() }).from(callLearnings).where(and(eq(callLearnings.tenantId, tenantId), gte(callLearnings.createdAt, seriesFrom))).groupBy(callDay),
    ]);

    const pipeline: Record<string, number> = {};
    let leadsTotal = 0;
    for (const r of pipelineRows) {
      const key = (r.status ?? 'new').toLowerCase();
      pipeline[key] = Number(r.c);
      leadsTotal += Number(r.c);
    }

    const leadByDay = new Map(leadSeries.map((r) => [r.d, Number(r.c)]));
    const callByDay = new Map(callSeries.map((r) => [r.d, Number(r.c)]));
    const series: MetricsSummary['series'] = utcDayBuckets(to, seriesDays).keys.map((key) => ({
      date: key,
      leads: leadByDay.get(key) ?? 0,
      calls: callByDay.get(key) ?? 0,
    }));

    const rawQuality = qualityRow[0]?.avg;
    const qualityScore = rawQuality == null ? null : Math.round(Number(rawQuality) * 10) / 10;

    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      days,
      kpis: {
        leadsTotal,
        qualified: pipeline['qualified'] ?? 0,
        booked: pipeline['booked'] ?? 0,
        callsTotal: Number(callsTotalRow[0]?.c ?? 0),
        callsInRange: Number(callsRangeRow[0]?.c ?? 0),
        qualityScore,
      },
      pipeline,
      series,
    };
  }

  /** Voice-agent supervision figures for one tenant. See `VoiceMetrics` for the two-column split. */
  async voice(tenantId: string, range: MetricsRange): Promise<VoiceMetrics> {
    const { from, to, days } = windowFor(range);

    const seriesDays = Math.max(days, 7);
    const seriesFrom = utcDayBuckets(to, seriesDays).start;

    const inRange = and(eq(callLearnings.tenantId, tenantId), gte(callLearnings.createdAt, from));
    const analysis = callLearnings.analysis;
    const report = callLearnings.callReport;
    const callDay = sql<string>`(${callLearnings.createdAt} at time zone 'utc')::date::text`;
    const endReason = sql<string | null>`${analysis} ->> 'end_reason'`;

    // percentile_cont over one of the CallReport's medians. `->>` yields SQL NULL for a missing key
    // and aggregates skip NULLs, so a call that recorded only some stages can't skew the others.
    const pct = (key: string, q: number) =>
      sql<number | null>`percentile_cont(${q}) within group (order by (${report} -> 'summary' ->> ${key})::float)`;
    /** A CallReport health counter, summed across calls. */
    const reportSum = (key: string) =>
      sql<number>`coalesce(sum((${report} -> 'summary' ->> ${key})::int), 0)`;

    const [countersRow, endReasonRows, latencyRows, overBudgetRes, seriesRows, openPeriodRows] =
      await Promise.all([
        this.db
          .select({
            total: sql<number>`count(*)`,
            failed: sql<number>`count(*) filter (where ${callLearnings.status} = 'failed')`,
            totalDurationSecs: sql<number>`coalesce(sum(${callLearnings.durationSecs}), 0)`,
            avgDurationSecs: sql<number | null>`avg(${callLearnings.durationSecs})`,
            disclosureMissed: sql<number>`count(*) filter (where ${analysis} ->> 'ai_disclosure' = 'missed')`,
            fragmentedTurnCalls: sql<number>`count(*) filter (where (${report} -> 'summary' ->> 'fragmentedTurns')::int > 0)`,
            fragmentedTurnsTotal: reportSum('fragmentedTurns'),
            cutOffsTotal: reportSum('cutOffs'),
          })
          .from(callLearnings)
          .where(inRange),
        this.db
          .select({ reason: endReason, c: count() })
          .from(callLearnings)
          .where(inRange)
          .groupBy(endReason),
        this.db
          .select({
            callsWithLatency: sql<number>`count(*)`,
            eouMedian: pct('endOfTurnMedianMs', 0.5),
            eouP95: pct('endOfTurnMedianMs', 0.95),
            ttftMedian: pct('llmTtftMedianMs', 0.5),
            ttftP95: pct('llmTtftMedianMs', 0.95),
            ttfbMedian: pct('ttsTtfbMedianMs', 0.5),
            ttfbP95: pct('ttsTtfbMedianMs', 0.95),
            worstMedian: pct('worstCaseMs', 0.5),
            worstP95: pct('worstCaseMs', 0.95),
            worstMax: sql<number | null>`max((${report} -> 'summary' ->> 'worstCaseMs')::float)`,
          })
          .from(callLearnings)
          .where(and(inRange, sql`${report} -> 'summary' ? 'endOfTurnMedianMs'`)),
        // Tool calls are an array inside the row, so this one needs a lateral unnest.
        this.db.execute(sql`
          select count(*)::int as c
          from ${callLearnings} cl,
               lateral jsonb_array_elements(coalesce(cl.analysis -> 'tool_calls', '[]'::jsonb)) tc
          where cl.tenant_id = ${tenantId}
            and cl.created_at >= ${from}
            and (tc ->> 'durationMs')::float > 500
        `),
        this.db
          .select({
            d: callDay,
            calls: sql<number>`count(*)`,
            durationSecs: sql<number>`coalesce(sum(${callLearnings.durationSecs}), 0)`,
            booked: sql<number>`count(*) filter (where ${analysis} ->> 'end_reason' = 'meeting_booked')`,
          })
          .from(callLearnings)
          .where(and(eq(callLearnings.tenantId, tenantId), gte(callLearnings.createdAt, seriesFrom)))
          .groupBy(callDay),
        // The tenant's own bundle. Period-scoped, not range-scoped — see `VoiceMetrics.bundle`.
        this.db
          .select({
            periodStart: usagePeriods.periodStart,
            periodEnd: usagePeriods.periodEnd,
            includedMinutes: usagePeriods.includedMinutes,
            overagePerMinuteAgorot: usagePeriods.overagePerMinuteAgorot,
            secondsUsed: usagePeriods.secondsUsed,
          })
          .from(usagePeriods)
          .where(and(eq(usagePeriods.tenantId, tenantId), eq(usagePeriods.status, 'open')))
          .limit(1),
      ]);

    const c = countersRow[0];
    const l = latencyRows[0];
    const overBudgetRows = (overBudgetRes as unknown as { rows?: Array<{ c: number }> }).rows
      ?? (overBudgetRes as unknown as Array<{ c: number }>);

    return assembleVoiceMetrics({
      range,
      from,
      to,
      days,
      seriesDays,
      counters: {
        total: Number(c?.total ?? 0),
        failed: Number(c?.failed ?? 0),
        totalDurationSecs: Number(c?.totalDurationSecs ?? 0),
        avgDurationSecs: c?.avgDurationSecs == null ? null : Number(c.avgDurationSecs),
        disclosureMissed: Number(c?.disclosureMissed ?? 0),
        fragmentedTurnCalls: Number(c?.fragmentedTurnCalls ?? 0),
        fragmentedTurnsTotal: Number(c?.fragmentedTurnsTotal ?? 0),
        cutOffsTotal: Number(c?.cutOffsTotal ?? 0),
      },
      endReasonRows: endReasonRows.map((r) => ({ reason: r.reason, c: Number(r.c) })),
      latencyRow: {
        callsWithLatency: Number(l?.callsWithLatency ?? 0),
        eouMedian: l?.eouMedian ?? null,
        eouP95: l?.eouP95 ?? null,
        ttftMedian: l?.ttftMedian ?? null,
        ttftP95: l?.ttftP95 ?? null,
        ttfbMedian: l?.ttfbMedian ?? null,
        ttfbP95: l?.ttfbP95 ?? null,
        worstMedian: l?.worstMedian ?? null,
        worstP95: l?.worstP95 ?? null,
        worstMax: l?.worstMax ?? null,
      },
      overBudgetToolCalls: Number(overBudgetRows?.[0]?.c ?? 0),
      openPeriod: openPeriodRows[0] ? { ...openPeriodRows[0] } : null,
      seriesRows: seriesRows.map((r) => ({
        d: r.d,
        calls: Number(r.calls),
        durationSecs: Number(r.durationSecs),
        booked: Number(r.booked),
      })),
    });
  }
}
