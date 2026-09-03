/**
 * RE-ARM THE CALLBACKS REDIS FORGOT.
 *
 * A callback lives in two places: a durable row in `callbacks`, and a delayed BullMQ job in Redis
 * that fires at `due_at`. The row is the authority — but the row cannot ring anybody. Only the job
 * can, and Redis is the half of the pair that can vanish without a sound.
 *
 * That is not hypothetical for this feature specifically: the ladder spans DAYS. A rung-3 job sits
 * in Redis for three business days. A Redis flush, an eviction, a restore from an older snapshot,
 * a `FLUSHALL` during an incident — any of them silently drops every pending callback in the
 * system, and the only symptom is a phone that never rings, which nobody can see in a log. The
 * rows survive and look perfectly healthy.
 *
 * So this script asks the one question nothing else asks: for each `pending` row, is its job still
 * there? And it fixes the second, rarer stuck state — a row left `dialing` because the process
 * died between "I am about to dial" and the write that records what happened.
 *
 * DRY RUN BY DEFAULT. It re-enqueues jobs that place PHONE CALLS, so it should be read before it
 * is believed. Same shape as `npm run usage:reconcile`.
 *
 * Usage:
 *   node scripts/callbacks-reconcile.mjs                    # report only
 *   node scripts/callbacks-reconcile.mjs --apply            # re-enqueue + rescue
 *   node scripts/callbacks-reconcile.mjs --tenant <uuid>    # scope to one tenant
 *   node scripts/callbacks-reconcile.mjs --ahead 1440       # also cover rows due this far ahead
 *                                                           # (minutes, default 4320 = 3 days)
 *   node scripts/callbacks-reconcile.mjs --stale 30         # `dialing` older than N min is stuck
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Queue } from 'bullmq';

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
/**
 * How far into the future to look. A job that is still weeks away is almost certainly fine and
 * re-enqueueing it costs nothing, but the window keeps a normal run cheap and its output readable.
 * Three days covers the whole ladder (rung 3 of a soft defer is +3 business days).
 */
const AHEAD_MINUTES = Number(arg('ahead') ?? 3 * 24 * 60);
/** A dial takes seconds. Anything still `dialing` after this long is a dead process, not a call. */
const STALE_DIALING_MINUTES = Number(arg('stale') ?? 30);

/**
 * MUST MATCH `callbackJobId` in `src/queues/callbacks.queue.ts`. Duplicated rather than imported
 * because this is a .mjs script and that module is TypeScript. If the two ever disagree this
 * script re-enqueues under an id the worker's cancellation path cannot remove — so the grammar is
 * spelled out here rather than assembled cleverly.
 */
function callbackJobId(callbackId, attempt, deferrals = 0) {
  return `callback-${callbackId}-a${attempt}${deferrals > 0 ? `-d${deferrals}` : ''}`;
}

async function main() {
  const client = new pg.Client({ connectionString: env('DATABASE_URL') });
  await client.connect();

  const queue = new Queue('callbacks', { connection: { url: env('REDIS_URL') } });

  const params = [`${AHEAD_MINUTES} minutes`];
  let tenantClause = '';
  if (TENANT) {
    params.push(TENANT);
    tenantClause = ` AND tenant_id = $${params.length}`;
  }

  const pending = await client.query(
    `SELECT id, tenant_id, lead_id, due_at, attempt, job_id, kind, state
       FROM callbacks
      WHERE state = 'pending'
        AND due_at < now() + $1::interval${tenantClause}
      ORDER BY due_at ASC`,
    params,
  );

  console.log(
    `pending callbacks due within ${AHEAD_MINUTES} minutes: ${pending.rowCount}` +
      (TENANT ? ` (tenant ${TENANT})` : ''),
  );

  const orphans = [];
  for (const row of pending.rows) {
    // The row's own job_id is the truth when it has one: a window deferral rewrote it with a
    // `-d<n>` suffix, and recomputing the bare id would check for a job that never existed.
    const jobId = row.job_id ?? callbackJobId(row.id, row.attempt);
    const job = await queue.getJob(jobId);
    if (!job) orphans.push({ ...row, jobId });
  }

  console.log(`\npending rows whose BullMQ job is GONE: ${orphans.length}`);
  for (const row of orphans) {
    const lateMin = Math.round((Date.now() - new Date(row.due_at).getTime()) / 60_000);
    console.log(
      `  ${row.id}  tenant ${row.tenant_id}  ${row.kind}  attempt ${row.attempt}` +
        `  due ${new Date(row.due_at).toISOString()} (${lateMin >= 0 ? `${lateMin}m late` : `in ${-lateMin}m`})` +
        `  job ${row.jobId}`,
    );
  }

  const staleParams = [`${STALE_DIALING_MINUTES} minutes`];
  let staleTenantClause = '';
  if (TENANT) {
    staleParams.push(TENANT);
    staleTenantClause = ` AND tenant_id = $${staleParams.length}`;
  }
  const stuck = await client.query(
    `SELECT id, tenant_id, attempt, updated_at
       FROM callbacks
      WHERE state = 'dialing'
        AND updated_at < now() - $1::interval${staleTenantClause}`,
    staleParams,
  );

  console.log(`\nrows stuck in 'dialing' for over ${STALE_DIALING_MINUTES} minutes: ${stuck.rowCount}`);
  for (const row of stuck.rows) {
    console.log(`  ${row.id}  tenant ${row.tenant_id}  attempt ${row.attempt}  since ${row.updated_at.toISOString()}`);
  }

  if (APPLY) {
    // A stuck `dialing` row goes back to `pending` FIRST, so the same pass re-arms it. `attempt` is
    // deliberately left alone: we do not know whether the phone rang, and counting a dial we
    // cannot prove would silently shorten that lead's ladder.
    for (const row of stuck.rows) {
      await client.query(
        `UPDATE callbacks SET state = 'pending', updated_at = now() WHERE id = $1 AND state = 'dialing'`,
        [row.id],
      );
      const jobId = callbackJobId(row.id, row.attempt);
      if (!(await queue.getJob(jobId))) {
        orphans.push({ id: row.id, tenant_id: row.tenant_id, attempt: row.attempt, due_at: new Date(), jobId });
      }
    }

    let requeued = 0;
    for (const row of orphans) {
      const delay = Math.max(0, new Date(row.due_at).getTime() - Date.now());
      await queue.add(
        'callback',
        { tenantId: row.tenant_id, callbackId: row.id, attempt: row.attempt, deferrals: 0 },
        { jobId: row.jobId, delay, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );
      // Keep the row pointing at the job that now exists, so cancellation still works by name.
      await client.query(`UPDATE callbacks SET job_id = $2, updated_at = now() WHERE id = $1`, [
        row.id,
        row.jobId,
      ]);
      requeued += 1;
    }
    console.log(`\napplied: ${requeued} job(s) re-enqueued, ${stuck.rowCount} stuck row(s) returned to pending.`);
    console.log('NOTE: a re-enqueued job fires against the ROW, which is still the authority — an');
    console.log('overdue callback is re-checked against the calling window before anything rings.');
  } else if (orphans.length || stuck.rowCount) {
    console.log('\nnothing written. re-run with --apply to re-enqueue.');
  } else {
    console.log('\nevery pending callback has a live job — nothing to do.');
  }

  await queue.close();
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
