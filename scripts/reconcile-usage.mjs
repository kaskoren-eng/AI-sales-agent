/**
 * REBUILD THE USAGE LEDGER FROM THE DURABLE TABLES.
 *
 * The meters are deliberately best-effort: `meterLead` and `meterCall` swallow their own errors,
 * because a counter must never be able to fail a customer's lead intake or an agent's call
 * teardown. That trade is only defensible because of THIS SCRIPT — the units are all rebuildable:
 *
 *   • a billable lead is a row in `leads`
 *   • a call's cost is in `call_learnings.call_report -> usage`
 *
 * So a metering failure is an accounting gap that can be closed later, not a number lost forever.
 * Without reconciliation, "never throws" would just mean "silently under-bills".
 *
 * It also fixes counter drift: `usage_periods` is a CACHE of the ledger, and any disagreement is
 * resolved by recomputing the cache — never by trusting it.
 *
 * DRY RUN BY DEFAULT. It writes money-shaped rows, so it should be read before it is believed.
 *
 * Usage:
 *   node scripts/reconcile-usage.mjs                      # report only
 *   node scripts/reconcile-usage.mjs --apply              # backfill + recompute
 *   node scripts/reconcile-usage.mjs --tenant <uuid>      # scope to one tenant
 *   node scripts/reconcile-usage.mjs --since 2026-08-01   # limit the window (default: 90 days)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(name) {
  if (process.env[name]) return process.env[name];
  const line = readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from environment and .env`);
  return line.slice(name.length + 1).trim();
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const APPLY = has('apply');
const TENANT = arg('tenant');
const SINCE = arg('since') ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

/**
 * Sources that create a `leads` row which is NOT a billable lead. These MUST match the exemptions
 * marked in the code (`usage-metering: exempt`) and pinned by
 * `src/modules/billing/metering-coverage.test.ts` — if they drift apart, this script will happily
 * bill for rows the live path deliberately skipped, and the customer sees a bill that does not
 * match their own lead list.
 */
const EXEMPT_SOURCES = ['web-call'];
const EXEMPT_STATUSES = ['opted_out'];

/**
 * Kept in step with `src/modules/billing/pricing.ts`. Duplicated rather than imported because this
 * is a .mjs script and the pricing module is TypeScript; the version string is what makes the
 * duplication detectable — a backfilled row tagged `2026-08-list-reconciled` can always be told
 * apart from one priced live.
 */
const RATES = {
  version: '2026-08-list',
  ilsPerUsd: 3.7,
  llmInputPerMTokensUsd: 2.5,
  llmCachedInputPerMTokensUsd: 0.25,
  llmOutputPerMTokensUsd: 10,
  sttPerMinuteUsd: 0.0025,
  ttsPerMCharsUsd: 65,
  platformPerMinuteUsd: 0.012,
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const toMilliAgorot = (usd) => Math.round(usd * RATES.ilsPerUsd * 100_000);

function costOfCall(usage, durationSec) {
  const u = usage ?? {};
  const prompt = num(u.llmPromptTokens);
  const cached = Math.min(num(u.llmPromptCachedTokens), prompt);
  const llmUsd =
    ((prompt - cached) / 1e6) * RATES.llmInputPerMTokensUsd +
    (cached / 1e6) * RATES.llmCachedInputPerMTokensUsd +
    (num(u.llmCompletionTokens) / 1e6) * RATES.llmOutputPerMTokensUsd;
  const sttUsd = (num(u.sttAudioDurationMs) / 60_000) * RATES.sttPerMinuteUsd;
  const ttsUsd = (num(u.ttsCharactersCount) / 1e6) * RATES.ttsPerMCharsUsd;
  const platformUsd = (num(durationSec) / 60) * RATES.platformPerMinuteUsd;
  return toMilliAgorot(llmUsd) + toMilliAgorot(sttUsd) + toMilliAgorot(ttsUsd) + toMilliAgorot(platformUsd);
}

/**
 * Israel-local anchor-day boundaries, mirroring `src/modules/billing/period.ts`.
 *
 * Postgres does the timezone maths here rather than JS, because it has the same tz database and
 * doing it in SQL keeps the boundary definition next to the rows it files.
 */
async function ensurePeriod(client, tenantId, occurredAt) {
  const { rows } = await client.query(
    `WITH t AS (
       SELECT COALESCE(billing_anchor_day, 1) AS anchor, plan_code,
              included_leads_override, overage_per_lead_agorot_override, monthly_price_agorot_override
       FROM tenants WHERE id = $1
     ), b AS (
       SELECT
         (CASE WHEN EXTRACT(DAY FROM ($2::timestamptz AT TIME ZONE 'Asia/Jerusalem')) >= t.anchor
               THEN date_trunc('month', ($2::timestamptz AT TIME ZONE 'Asia/Jerusalem'))
               ELSE date_trunc('month', ($2::timestamptz AT TIME ZONE 'Asia/Jerusalem')) - interval '1 month'
          END + (t.anchor - 1) * interval '1 day') AS start_local,
         t.*
       FROM t
     )
     SELECT (b.start_local AT TIME ZONE 'Asia/Jerusalem') AS period_start,
            ((b.start_local + interval '1 month') AT TIME ZONE 'Asia/Jerusalem') AS period_end,
            b.plan_code, b.included_leads_override, b.overage_per_lead_agorot_override,
            b.monthly_price_agorot_override
     FROM b`,
    [tenantId, occurredAt],
  );
  if (!rows[0]) return null;
  const b = rows[0];

  const plan = b.plan_code
    ? (await client.query('SELECT monthly_price_agorot, included_leads, overage_per_lead_agorot FROM plans WHERE code = $1', [b.plan_code])).rows[0]
    : null;

  const inserted = await client.query(
    `INSERT INTO usage_periods
       (tenant_id, period_start, period_end, plan_code, monthly_price_agorot, included_leads, overage_per_lead_agorot, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open')
     ON CONFLICT (tenant_id, period_start) DO NOTHING
     RETURNING id`,
    [
      tenantId, b.period_start, b.period_end, b.plan_code,
      b.monthly_price_agorot_override ?? plan?.monthly_price_agorot ?? 0,
      b.included_leads_override ?? plan?.included_leads ?? null,
      b.overage_per_lead_agorot_override ?? plan?.overage_per_lead_agorot ?? 0,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  const existing = await client.query('SELECT id FROM usage_periods WHERE tenant_id = $1 AND period_start = $2', [tenantId, b.period_start]);
  return existing.rows[0]?.id ?? null;
}

async function main() {
  const client = new pg.Client({ connectionString: env('DATABASE_URL') });
  await client.connect();

  const scope = TENANT ? 'AND l.tenant_id = $2' : '';
  const params = TENANT ? [SINCE, TENANT] : [SINCE];

  console.log(`\nreconcile-usage — since ${SINCE}${TENANT ? `, tenant ${TENANT}` : ', all tenants'}`);
  console.log(APPLY ? 'MODE: APPLY (writes)\n' : 'MODE: dry run (no writes — pass --apply to fix)\n');

  // ── 1. Leads with no ledger row ──────────────────────────────────────────────
  const missingLeads = await client.query(
    `SELECT l.id, l.tenant_id, l.source, l.created_at
     FROM leads l
     LEFT JOIN usage_events e
       ON e.tenant_id = l.tenant_id AND e.kind = 'lead' AND e.dedupe_key = l.id::text
     WHERE e.id IS NULL
       AND l.created_at >= $1
       AND NOT (l.source = ANY($${TENANT ? 3 : 2}::text[]))
       AND NOT (l.status = ANY($${TENANT ? 4 : 3}::text[]))
       ${scope}
     ORDER BY l.created_at`,
    TENANT ? [SINCE, TENANT, EXEMPT_SOURCES, EXEMPT_STATUSES] : [SINCE, EXEMPT_SOURCES, EXEMPT_STATUSES],
  );

  console.log(`unmetered leads: ${missingLeads.rowCount}`);
  for (const row of missingLeads.rows.slice(0, 20)) {
    console.log(`  ${row.created_at.toISOString().slice(0, 10)}  ${row.tenant_id}  ${row.id}  (${row.source ?? 'unknown'})`);
  }
  if (missingLeads.rowCount > 20) console.log(`  … and ${missingLeads.rowCount - 20} more`);

  const touchedPeriods = new Set();

  if (APPLY) {
    for (const row of missingLeads.rows) {
      const periodId = await ensurePeriod(client, row.tenant_id, row.created_at);
      await client.query(
        `INSERT INTO usage_events (tenant_id, kind, dedupe_key, billable_units, cost_milli_agorot, metadata, period_id, occurred_at)
         VALUES ($1, 'lead', $2, 1, 0, $3, $4, $5)
         ON CONFLICT (tenant_id, kind, dedupe_key) DO NOTHING`,
        [row.tenant_id, row.id, JSON.stringify({ source: row.source, backfilled: true }), periodId, row.created_at],
      );
      if (periodId) touchedPeriods.add(periodId);
    }
  }

  // ── 2. Calls with no ledger row ──────────────────────────────────────────────
  const missingCalls = await client.query(
    `SELECT c.id, c.tenant_id, c.conference_name, c.duration_secs, c.created_at,
            c.call_report -> 'usage' AS usage
     FROM call_learnings c
     LEFT JOIN usage_events e
       ON e.tenant_id = c.tenant_id AND e.kind = 'call' AND e.dedupe_key = c.conference_name
     WHERE e.id IS NULL
       AND c.created_at >= $1
       AND c.label = 'livekit'
       ${TENANT ? 'AND c.tenant_id = $2' : ''}
     ORDER BY c.created_at`,
    params,
  );

  console.log(`\nunmetered calls: ${missingCalls.rowCount}`);
  let backfilledCost = 0;
  for (const row of missingCalls.rows.slice(0, 20)) {
    const cost = costOfCall(row.usage, row.duration_secs);
    console.log(`  ${row.created_at.toISOString().slice(0, 10)}  ${row.conference_name}  ₪${(cost / 100_000).toFixed(2)}${row.usage ? '' : '  (no usage recorded — 0)'}`);
  }
  if (missingCalls.rowCount > 20) console.log(`  … and ${missingCalls.rowCount - 20} more`);

  if (APPLY) {
    for (const row of missingCalls.rows) {
      const cost = costOfCall(row.usage, row.duration_secs);
      backfilledCost += cost;
      const periodId = await ensurePeriod(client, row.tenant_id, row.created_at);
      await client.query(
        `INSERT INTO usage_events (tenant_id, kind, dedupe_key, billable_units, cost_milli_agorot, metadata, period_id, occurred_at)
         VALUES ($1, 'call', $2, 0, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, kind, dedupe_key) DO NOTHING`,
        [
          row.tenant_id, row.conference_name, cost,
          JSON.stringify({ usage: row.usage, rateVersion: `${RATES.version}-reconciled`, backfilled: true, durationSec: row.duration_secs }),
          periodId, row.created_at,
        ],
      );
      if (periodId) touchedPeriods.add(periodId);
    }
  }

  // ── 3. Counter drift ─────────────────────────────────────────────────────────
  // The counters are a cache of the ledger. Disagreement is ALWAYS resolved towards the ledger —
  // the opposite direction would let a drifted counter bill units that have no evidence behind them.
  const drift = await client.query(
    `SELECT p.id, p.tenant_id, p.period_start, p.leads_used, p.measured_cost_milli_agorot,
            COALESCE(a.units, 0) AS real_units, COALESCE(a.cost, 0) AS real_cost
     FROM usage_periods p
     LEFT JOIN (
       SELECT period_id, SUM(billable_units) AS units, SUM(cost_milli_agorot) AS cost
       FROM usage_events GROUP BY period_id
     ) a ON a.period_id = p.id
     WHERE (p.leads_used <> COALESCE(a.units, 0) OR p.measured_cost_milli_agorot <> COALESCE(a.cost, 0))
       ${TENANT ? 'AND p.tenant_id = $1' : ''}`,
    TENANT ? [TENANT] : [],
  );

  console.log(`\nperiods whose counters disagree with the ledger: ${drift.rowCount}`);
  for (const row of drift.rows) {
    console.log(`  ${row.period_start.toISOString().slice(0, 10)}  ${row.tenant_id}  leads ${row.leads_used} → ${row.real_units}`);
  }

  if (APPLY) {
    for (const row of drift.rows) touchedPeriods.add(row.id);
    for (const periodId of touchedPeriods) {
      await client.query(
        `UPDATE usage_periods p SET
           leads_used = COALESCE(agg.units, 0),
           calls_count = COALESCE(agg.calls, 0),
           measured_cost_milli_agorot = COALESCE(agg.cost, 0),
           updated_at = now()
         FROM (
           SELECT SUM(billable_units) AS units,
                  COUNT(*) FILTER (WHERE kind = 'call') AS calls,
                  SUM(cost_milli_agorot) AS cost
           FROM usage_events WHERE period_id = $1
         ) agg
         WHERE p.id = $1`,
        [periodId],
      );
    }
    console.log(
      `\napplied: ${missingLeads.rowCount} lead events, ${missingCalls.rowCount} call events ` +
      `(₪${(backfilledCost / 100_000).toFixed(2)} of cost), ${touchedPeriods.size} periods recomputed`,
    );
  } else if (missingLeads.rowCount || missingCalls.rowCount || drift.rowCount) {
    console.log('\nnothing written. re-run with --apply to fix.');
  } else {
    console.log('\nledger and counters agree — nothing to do.');
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
