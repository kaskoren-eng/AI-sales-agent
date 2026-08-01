import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leads, callLearnings } from '../../db/schema/index.js';

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

export class MetricsService {
  constructor(private db: Database) {}

  async summary(tenantId: string, range: MetricsRange): Promise<MetricsSummary> {
    const { from, to, days } = windowFor(range);

    // Chart trend: at least 7 daily buckets even for "today", so it renders as a line, not a dot.
    const seriesDays = Math.max(days, 7);
    const seriesFrom = new Date(to);
    seriesFrom.setDate(seriesFrom.getDate() - (seriesDays - 1));
    seriesFrom.setHours(0, 0, 0, 0);

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
    const series: MetricsSummary['series'] = [];
    for (let i = 0; i < seriesDays; i++) {
      const d = new Date(seriesFrom);
      d.setDate(seriesFrom.getDate() + i);
      const key = dayKey(d);
      series.push({ date: key, leads: leadByDay.get(key) ?? 0, calls: callByDay.get(key) ?? 0 });
    }

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
}
