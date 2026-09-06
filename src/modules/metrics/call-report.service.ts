/**
 * READS ONE CALL'S REPORT OUT OF THE DATABASE, for the operator console.
 *
 * Keyed on `call_learnings.id`, NOT on `conversations.id`. That is not a style choice: a LiveKit
 * call has no conversations row of its own (`agent.ts` carries `conversationId` only when it
 * happens to have one), which is the same reason `metrics.service.ts` aggregates on
 * `call_learnings` directly. A route keyed on the conversation would silently be unable to reach a
 * large share of the reports that exist, and would look like it was working.
 *
 * Cross-tenant by design — this serves the `ADMIN_API_KEY` console only, and the tenant id is
 * returned as data rather than used as a filter. There is no tenant-facing route: the report names
 * the vendor stack, the prompt-cache rate and the discarded drafts, and that stays internal
 * (Koren, 2026-09-06).
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { callLearnings, tenants } from '../../db/schema/index.js';
import { buildCallReportView, type CallReportView } from './call-report-view.js';

/**
 * WHICH KIND OF NOTHING. `call_report` is nullable and only LiveKit calls ever wrote it, so most
 * historical rows are empty. "No data" and "no such call" are different answers and the page says
 * which — a single empty state that covered both would read as though the feature were broken.
 */
export type CallReportAbsence = 'no_learnings_row' | 'no_report';

export interface CallReportEnvelope {
  learningId: string;
  tenantId: string;
  tenantName: string | null;
  room: string | null;
  createdAt: string | null;
  durationSecs: number | null;
  /** pending | transcribing | analyzed | failed. LiveKit rows are inserted 'pending' and stay so. */
  status: string;
  outcome: string | null;
  endReason: string | null;
  /**
   * Whether a recording URL is stored — nothing more. NOTHING SERVES THE AUDIO: the proxy went with
   * the retired engine, so the page must never offer a play button that 404s.
   */
  recordingStored: boolean;
  report: CallReportView | null;
  /** Non-null exactly when `report` is null. */
  absence: CallReportAbsence | null;
}

export interface AdminCallListItem {
  learningId: string;
  tenantId: string;
  tenantName: string | null;
  room: string | null;
  createdAt: string | null;
  durationSecs: number | null;
  status: string;
  outcome: string | null;
  /** Computed in SQL. The jsonb column never leaves the database for a list of 50 rows. */
  hasReport: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class CallReportService {
  constructor(private readonly db: Database) {}

  /**
   * One call's report for the operator console.
   *
   * Note what this does NOT do: it does not swallow a query failure. `calls.service.ts` treats the
   * learnings row as optional enrichment and catches, which is right there — but here the row IS
   * the payload, and a caught error would render as "no data for this call", a comfortable answer
   * to a question that actually failed.
   */
  async byLearningId(learningId: string): Promise<CallReportEnvelope | null> {
    const [row] = await this.db
      .select({
        id: callLearnings.id,
        tenantId: callLearnings.tenantId,
        tenantName: tenants.name,
        room: callLearnings.conferenceName,
        createdAt: callLearnings.createdAt,
        durationSecs: callLearnings.durationSecs,
        status: callLearnings.status,
        outcome: callLearnings.outcome,
        recordingUrl: callLearnings.recordingUrl,
        callReport: callLearnings.callReport,
        // Only the one key the verdict strip needs. `analysis` is rewritten wholesale by the
        // GPT-analysis worker and carries the model's prose; the console has no business shipping
        // all of it to a browser to read a single enum.
        endReason: sql<string | null>`${callLearnings.analysis} ->> 'end_reason'`,
      })
      .from(callLearnings)
      .leftJoin(tenants, eq(tenants.id, callLearnings.tenantId))
      .where(eq(callLearnings.id, learningId))
      .limit(1);

    if (!row) return null;

    const report = buildCallReportView(row.callReport, { endReason: row.endReason });

    return {
      learningId: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenantName ?? null,
      room: row.room ?? null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      durationSecs: row.durationSecs ?? null,
      status: row.status,
      outcome: row.outcome ?? null,
      endReason: row.endReason ?? null,
      recordingStored: row.recordingUrl !== null && row.recordingUrl !== undefined,
      report,
      // `no_learnings_row` is unreachable from here (we found the row), but the union is shared with
      // the page, which also has to render the 404 case.
      absence: report === null ? 'no_report' : null,
    };
  }

  /**
   * Recent calls across every tenant, newest first.
   *
   * The unfiltered ordering does not use `call_learnings_tenant_created_idx` — its leading column
   * is `tenant_id` — but at 50 rows on this table's volume that costs nothing measurable, and an
   * index would mean claiming a migration number in a shared file for a console query. If this
   * table grows by an order of magnitude, revisit it then rather than pre-emptively.
   */
  async listRecent(opts: {
    limit?: number;
    tenantId?: string;
    withReportOnly?: boolean;
  }): Promise<AdminCallListItem[]> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)));

    const filters = [
      ...(opts.tenantId ? [eq(callLearnings.tenantId, opts.tenantId)] : []),
      ...(opts.withReportOnly ? [isNotNull(callLearnings.callReport)] : []),
    ];

    const rows = await this.db
      .select({
        id: callLearnings.id,
        tenantId: callLearnings.tenantId,
        tenantName: tenants.name,
        room: callLearnings.conferenceName,
        createdAt: callLearnings.createdAt,
        durationSecs: callLearnings.durationSecs,
        status: callLearnings.status,
        outcome: callLearnings.outcome,
        // Presence only. Selecting the column itself would drag every transcript in the page of
        // results across the wire to answer a yes/no question.
        hasReport: sql<boolean>`${callLearnings.callReport} is not null`,
      })
      .from(callLearnings)
      .leftJoin(tenants, eq(tenants.id, callLearnings.tenantId))
      // `and()` of nothing is undefined, which drizzle reads as "no predicate" — so an unfiltered
      // list stays unfiltered and two filters stay two, with no branch to get wrong.
      .where(and(...filters))
      .orderBy(desc(callLearnings.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      learningId: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenantName ?? null,
      room: r.room ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      durationSecs: r.durationSecs ?? null,
      status: r.status,
      outcome: r.outcome ?? null,
      hasReport: r.hasReport === true,
    }));
  }
}
