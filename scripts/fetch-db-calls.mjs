/**
 * Pulls call reports out of the DATABASE and writes them where `npm run call:report` can read them.
 *
 * WHY THIS EXISTS. There are three places a call report can live and, until now, only two were
 * reachable:
 *
 *   1. `call-reports/*.json` on the machine that ran the agent — fine for a laptop call, useless
 *      for production, where the agent's filesystem is ephemeral and unreachable.
 *   2. `lk agent logs` — the agent prints the whole report as one `call_report_json` line, which
 *      `fetch-cloud-calls.mjs` fishes out. But that command STREAMS: it shows what scrolls past
 *      during its window, so it only ever catches a call that is happening right now. Asking it
 *      about yesterday's call returns nothing, which reads exactly like "no calls have happened".
 *   3. `call_learnings.call_report` — the durable copy, written at teardown, kept forever. This is
 *      the only source that can answer "what happened on the last call" after the fact, and it had
 *      no reader.
 *
 * So this fetches (3) and writes it into the same directory as (1), which means the existing
 * renderer works unchanged — one source of truth for how a call report is displayed.
 *
 * THE CREDENTIAL NEVER NEEDS TO BE TYPED OR PASTED. Run it through the platform that already holds
 * it:
 *
 *   railway run node scripts/fetch-db-calls.mjs        # production
 *   node scripts/fetch-db-calls.mjs                    # whatever DATABASE_URL/.env points at
 *   railway run node scripts/fetch-db-calls.mjs --limit 10
 *
 * Then: npm run call:report            (the most recent)
 *       npm run call:report -- all     (one line each, to compare)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'call-reports');

function env(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(join(ROOT, '.env'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  } catch {
    // no .env here — that is the normal case under `railway run`
  }
  return undefined;
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const LIMIT = Number(arg('limit') ?? 5);
const url = env('DATABASE_URL');

if (!url) {
  console.error(`DATABASE_URL is not set, and there is no .env here.

For production, let the platform inject it rather than copying it anywhere:

    railway run node scripts/fetch-db-calls.mjs

A database URL pasted into a terminal is in the shell history; pasted into a chat window it is
somewhere else entirely. Neither is needed — the CLI already holds it.`);
  process.exit(1);
}

// Never print the credential, only where it points — enough to catch "I meant production".
console.log(`reading calls from ${url.replace(/:\/\/[^@]*@/, '://***@').replace(/\?.*/, '')}\n`);

const client = new pg.Client({
  connectionString: url,
  // Railway's managed Postgres presents a certificate the local trust store does not recognise.
  ...(url.includes('localhost') || url.includes('127.0.0.1') ? {} : { ssl: { rejectUnauthorized: false } }),
});
await client.connect();

let rows;
try {
  ({ rows } = await client.query(
    `SELECT id, tenant_id, conference_name, created_at, duration_secs, call_report
       FROM call_learnings
      WHERE call_report IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [LIMIT],
  ));
} catch (err) {
  // 42703 = undefined_column. This database is behind on migrations — `call_report` arrived with
  // the LiveKit agent. Worth catching by hand because the raw pg error is a wall of stack trace
  // that says "column does not exist" and nothing about which of the several databases in play
  // this is, or what to do about it.
  if (err?.code === '42703') {
    console.error(`This database has no \`call_learnings.call_report\` column, so its migrations are behind.

That column is where the LiveKit agent stores the full call report. Either point at the database
the agent actually writes to, or bring this one up to date:

    npm run db:migrate

If you meant production, run the fetch through the platform that holds its credentials instead:

    railway run node scripts/fetch-db-calls.mjs`);
    await client.end();
    process.exit(1);
  }
  throw err;
}

if (rows.length === 0) {
  // Distinguish "no calls" from "calls, but none carrying a report" — they need different fixes.
  const { rows: any } = await client.query('SELECT count(*)::int AS n, max(created_at) AS latest FROM call_learnings');
  console.log(`No call reports found.

call_learnings holds ${any[0].n} row(s)${any[0].latest ? `, most recent ${any[0].latest.toISOString()}` : ''}, none with a
call_report column populated. That column is written by the LiveKit agent at teardown, so rows
older than it — or rows from the retired Retell engine — will not have one.`);
  await client.end();
  process.exit(0);
}

await mkdir(DIR, { recursive: true });

let written = 0;
for (const row of rows) {
  const report = typeof row.call_report === 'string' ? JSON.parse(row.call_report) : row.call_report;
  // Name the file after the call's OWN start time, matching what the agent writes locally, so both
  // sources sort into one timeline instead of two interleaved ones.
  const stamp = (report.startedAt ?? row.created_at.toISOString()).replace(/[:.]/g, '-');
  await writeFile(join(DIR, `${stamp}.json`), JSON.stringify(report, null, 2));
  written += 1;

  const s = report.summary ?? {};
  const ms = (v) => (typeof v === 'number' ? `${Math.round(v)}ms` : '—');
  console.log(
    `  ${String(report.startedAt ?? row.created_at.toISOString()).slice(0, 16).replace('T', ' ')}  ` +
      `${String(row.duration_secs ?? report.durationSec ?? '?').padStart(4)}s  ` +
      `eou ${ms(s.endOfTurnMedianMs).padStart(8)}  llm ${ms(s.llmTtftMedianMs).padStart(8)}  tts ${ms(s.ttsTtfbMedianMs).padStart(7)}  ` +
      `${row.conference_name ?? ''}`,
  );
}

await client.end();
console.log(`\n${written} report(s) written to call-reports/.\n\nNow run:  npm run call:report        (the most recent, in full)`);
