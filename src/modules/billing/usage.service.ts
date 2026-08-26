import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { tenants, usageEvents, usagePeriods, plans } from '../../db/schema/index.js';
import { periodBounds } from './period.js';
import { costOfCall, readUsageSummary, RATE_CARD, type RateCard } from './pricing.js';

/**
 * THE WRITE PATH FOR METERING. No enforcement, no UI — meters run silently (Phase 5a).
 *
 * It ships before the thing that reads it because usage CANNOT BE BACKFILLED FROM NOTHING, and the
 * first invoice dispute is unwinnable without a ledger. A quota screen built a month later reads a
 * month of history; a meter built a month later reads an empty table.
 *
 * ── The two rules this file exists to enforce ──
 *
 * 1. **A unit is counted at most once.** Guaranteed by the `(tenant_id, kind, dedupe_key)` unique
 *    index, not by application logic. Retried BullMQ jobs, double-delivered webhooks and a worker
 *    SIGKILLed mid-write all converge on the same row.
 * 2. **The counter never disagrees with the ledger.** The event insert and the period increment
 *    happen in ONE transaction, and the increment only runs when the insert actually inserted. A
 *    counter that drifts high bills a customer for units with no evidence behind them.
 */

/** What a caller knows about a billable thing that happened. */
export interface UsageRecordInput {
  tenantId: string;
  kind: 'lead' | 'call';
  /** Unique within (tenant, kind). Lead id for leads, room name for calls. */
  dedupeKey: string;
  /**
   * The billable quantity, IN THE UNIT OF ITS KIND: 1 per lead, seconds for a call.
   *
   * One column, two units, which is only safe because every reader splits on `kind` — see
   * `recomputePeriod`. It used to be summed across kinds into `leads_used`; that was correct only
   * while calls were always 0.
   */
  billableUnits?: number;
  costMilliAgorot?: number;
  metadata?: Record<string, unknown>;
  /** When it happened — decides the period. Defaults to now. */
  occurredAt?: Date;
}

export interface UsageRecordResult {
  /** False when the unique index rejected it — i.e. this unit was already counted. Not an error. */
  recorded: boolean;
  periodId: string | null;
}

/** Plan values as they apply to one tenant, after negotiated overrides. */
interface EffectivePlan {
  planCode: string | null;
  monthlyPriceAgorot: number;
  includedLeads: number | null;
  overagePerLeadAgorot: number;
  includedMinutes: number | null;
  overagePerMinuteAgorot: number;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function readEffectivePlan(tx: Tx, tenantId: string): Promise<{ plan: EffectivePlan; anchorDay: number } | null> {
  const [row] = await tx
    .select({
      planCode: tenants.planCode,
      anchorDay: tenants.billingAnchorDay,
      includedOverride: tenants.includedLeadsOverride,
      overageOverride: tenants.overagePerLeadAgorotOverride,
      priceOverride: tenants.monthlyPriceAgorotOverride,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!row) return null;

  // No plan (or a plan row that vanished) means free and unlimited — nulls, not zeroes: a zero
  // allowance would read as "every minute is overage".
  let base: {
    monthlyPriceAgorot: number;
    includedLeads: number | null;
    overagePerLeadAgorot: number;
    includedMinutes: number | null;
    overagePerMinuteAgorot: number;
  } = {
    monthlyPriceAgorot: 0,
    includedLeads: null,
    overagePerLeadAgorot: 0,
    includedMinutes: null,
    overagePerMinuteAgorot: 0,
  };

  if (row.planCode) {
    const [p] = await tx
      .select({
        monthlyPriceAgorot: plans.monthlyPriceAgorot,
        includedLeads: plans.includedLeads,
        overagePerLeadAgorot: plans.overagePerLeadAgorot,
        includedMinutes: plans.includedMinutes,
        overagePerMinuteAgorot: plans.overagePerMinuteAgorot,
      })
      .from(plans)
      .where(eq(plans.code, row.planCode))
      .limit(1);
    if (p) base = p;
  }

  return {
    anchorDay: row.anchorDay ?? 1,
    plan: {
      planCode: row.planCode ?? null,
      // `??` not `||`: a negotiated override of 0 (a free month, a comped tier) is a real value and
      // must not fall through to the plan's price.
      monthlyPriceAgorot: row.priceOverride ?? base.monthlyPriceAgorot,
      includedLeads: row.includedOverride ?? base.includedLeads,
      overagePerLeadAgorot: row.overageOverride ?? base.overagePerLeadAgorot,
      // No per-tenant minute overrides yet — `tenants` carries lead-shaped override columns only.
      // A negotiated minute bundle needs two more columns there and in reconcile-usage.mjs.
      includedMinutes: base.includedMinutes,
      overagePerMinuteAgorot: base.overagePerMinuteAgorot,
    },
  };
}

/**
 * Find or open the billing period containing `at`, snapshotting the plan as it is RIGHT NOW.
 *
 * The snapshot is the point. If a customer upgrades on the 20th, the month they are halfway
 * through must not retroactively reprice — reading the plan live at invoice time would do exactly
 * that, and they would receive a bill for a month they never agreed to.
 *
 * Race-safe by the `(tenant_id, period_start)` unique index rather than by locking: two leads
 * arriving in the same millisecond at the top of a month both try to open the period, one insert
 * loses, and both then read the same row.
 */
export async function ensureOpenPeriod(tx: Tx, tenantId: string, at: Date): Promise<string | null> {
  const resolved = await readEffectivePlan(tx, tenantId);
  if (!resolved) return null; // Tenant is gone. The FK would reject the event anyway.

  const bounds = periodBounds(resolved.anchorDay, at);

  const existing = await tx
    .select({ id: usagePeriods.id })
    .from(usagePeriods)
    .where(and(eq(usagePeriods.tenantId, tenantId), eq(usagePeriods.periodStart, bounds.start)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await tx
    .insert(usagePeriods)
    .values({
      tenantId,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      planCode: resolved.plan.planCode,
      monthlyPriceAgorot: resolved.plan.monthlyPriceAgorot,
      includedLeads: resolved.plan.includedLeads,
      overagePerLeadAgorot: resolved.plan.overagePerLeadAgorot,
      includedMinutes: resolved.plan.includedMinutes,
      overagePerMinuteAgorot: resolved.plan.overagePerMinuteAgorot,
      status: 'open',
    })
    .onConflictDoNothing({ target: [usagePeriods.tenantId, usagePeriods.periodStart] })
    .returning({ id: usagePeriods.id });
  if (inserted[0]) return inserted[0].id;

  // Lost the race — the winner's row is the one to use.
  const [winner] = await tx
    .select({ id: usagePeriods.id })
    .from(usagePeriods)
    .where(and(eq(usagePeriods.tenantId, tenantId), eq(usagePeriods.periodStart, bounds.start)))
    .limit(1);
  return winner?.id ?? null;
}

/**
 * Append one event to the ledger and move the period counter, atomically.
 *
 * THROWS on database failure — deliberately. Callers on a customer-facing path wrap this in
 * `meterLead`/`meterCall` below, which swallow and log; callers in a job that can be retried
 * should let it throw. Making the primitive honest and the wrapper forgiving keeps the choice at
 * the call site instead of hiding it here.
 */
export async function recordUsageEvent(db: Database, input: UsageRecordInput): Promise<UsageRecordResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const billableUnits = input.billableUnits ?? 0;
  const costMilliAgorot = Math.max(0, Math.round(input.costMilliAgorot ?? 0));

  return db.transaction(async (tx) => {
    const periodId = await ensureOpenPeriod(tx, input.tenantId, occurredAt);

    const inserted = await tx
      .insert(usageEvents)
      .values({
        tenantId: input.tenantId,
        kind: input.kind,
        dedupeKey: input.dedupeKey.slice(0, 128),
        billableUnits,
        costMilliAgorot,
        metadata: input.metadata ?? {},
        periodId,
        occurredAt,
      })
      // THE IDEMPOTENCY GUARANTEE. The index arbitrates; nothing here has to check first, which is
      // what makes it safe under concurrency rather than merely usually-correct.
      .onConflictDoNothing({ target: [usageEvents.tenantId, usageEvents.kind, usageEvents.dedupeKey] })
      .returning({ id: usageEvents.id });

    // Already counted. Returning quietly is correct: a retried job must be a no-op, not an error.
    if (!inserted[0]) return { recorded: false, periodId };

    if (periodId) {
      // In-database arithmetic, not read-modify-write. Two concurrent leads must both land; a
      // read-then-write would lose one and under-bill, which is the failure nobody notices.
      await tx
        .update(usagePeriods)
        .set({
          // Each counter takes units only from its OWN kind. `billableUnits` carries leads on a
          // lead row and seconds on a call row, so adding it to leadsUsed unconditionally — which
          // is what this did while calls were always 0 — starts inflating leads by call seconds
          // the moment calls become billable.
          leadsUsed: sql`${usagePeriods.leadsUsed} + ${input.kind === 'lead' ? billableUnits : 0}`,
          secondsUsed: sql`${usagePeriods.secondsUsed} + ${input.kind === 'call' ? billableUnits : 0}`,
          callsCount: sql`${usagePeriods.callsCount} + ${input.kind === 'call' ? 1 : 0}`,
          measuredCostMilliAgorot: sql`${usagePeriods.measuredCostMilliAgorot} + ${costMilliAgorot}`,
          updatedAt: new Date(),
        })
        .where(eq(usagePeriods.id, periodId));
    }

    return { recorded: true, periodId };
  });
}

/**
 * Meter a newly created lead. ONE BILLABLE UNIT — this is the thing the invoice is made of.
 *
 * Never throws. A metering failure must not fail lead creation: the lead is the customer's core
 * product event, and refusing to accept it because a counter is unavailable trades a recoverable
 * accounting gap for an unrecoverable business one.
 *
 * Swallowing is safe here ONLY because `leads` is a durable table, so a missed event can be
 * rebuilt from it — `scripts/reconcile-usage.mjs` does exactly that. The log line is the signal
 * that reconciliation has work to do.
 */
export async function meterLead(
  db: Database,
  params: { tenantId: string; leadId: string; source?: string | null; createdAt?: Date },
): Promise<void> {
  try {
    await recordUsageEvent(db, {
      tenantId: params.tenantId,
      kind: 'lead',
      dedupeKey: params.leadId,
      billableUnits: 1,
      ...(params.createdAt ? { occurredAt: params.createdAt } : {}),
      metadata: { source: params.source ?? null },
    });
  } catch (err) {
    console.error(
      'usage_meter_failed',
      JSON.stringify({
        kind: 'lead',
        tenantId: params.tenantId,
        leadId: params.leadId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Meter a finished call. ITS DURATION IN SECONDS IS THE BILLABLE QUANTITY.
 *
 * Calls used to be metered at zero units — a pure cost signal — because the invoice was made of
 * leads. The bundle is now a number of MINUTES, so the call is the billable event and its seconds
 * are what the allowance is spent on. Seconds rather than minutes so rounding happens once, when a
 * bill is written, instead of once per call.
 *
 * Still records `costMilliAgorot` alongside: what we charge and what we pay are different numbers
 * and both matter, which is why they are different columns.
 *
 * Called from the agent's shutdown handler, where nothing may throw: an exception there loses the
 * call report and the `call_learnings` row along with the meter.
 */
export async function meterCall(
  db: Database,
  params: {
    tenantId: string;
    roomName: string;
    usage: unknown;
    durationSec?: number;
    endedAt?: Date;
    rates?: RateCard;
  },
): Promise<void> {
  try {
    const usage = readUsageSummary(params.usage, params.durationSec);
    const cost = costOfCall(usage, params.rates ?? RATE_CARD);
    await recordUsageEvent(db, {
      tenantId: params.tenantId,
      kind: 'call',
      dedupeKey: params.roomName,
      // Negative or absent durations round to 0 rather than crediting minutes back.
      billableUnits: Math.max(0, Math.round(params.durationSec ?? 0)),
      costMilliAgorot: cost.totalMilliAgorot,
      ...(params.endedAt ? { occurredAt: params.endedAt } : {}),
      metadata: { usage, breakdown: cost, rateVersion: cost.rateVersion, durationSec: params.durationSec ?? null },
    });
  } catch (err) {
    console.error(
      'usage_meter_failed',
      JSON.stringify({
        kind: 'call',
        tenantId: params.tenantId,
        roomName: params.roomName,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Rebuild a period's counters from the ledger.
 *
 * The counters are a CACHE; the ledger is the truth. Any disagreement is resolved in that
 * direction, never the other — which is what makes it safe for the counter to be maintained by a
 * best-effort writer at all.
 */
export async function recomputePeriod(db: Database, periodId: string): Promise<void> {
  await db.execute(sql`
    UPDATE usage_periods p SET
      leads_used = COALESCE(agg.lead_units, 0),
      seconds_used = COALESCE(agg.call_seconds, 0),
      calls_count = COALESCE(agg.calls, 0),
      measured_cost_milli_agorot = COALESCE(agg.cost, 0),
      updated_at = now()
    FROM (
      SELECT
        -- FILTERED BY KIND, both of them. billable_units means leads on one row and seconds on
        -- another; an unfiltered SUM would rebuild leads_used as leads + call-seconds and then
        -- report the honest counter as the drifted one.
        SUM(billable_units) FILTER (WHERE kind = 'lead') AS lead_units,
        SUM(billable_units) FILTER (WHERE kind = 'call') AS call_seconds,
        COUNT(*) FILTER (WHERE kind = 'call') AS calls,
        SUM(cost_milli_agorot) AS cost
      FROM usage_events WHERE period_id = ${periodId}
    ) agg
    WHERE p.id = ${periodId}
  `);
}
