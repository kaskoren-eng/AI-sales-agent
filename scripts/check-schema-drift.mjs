#!/usr/bin/env node
/**
 * Does the database the migrations BUILD match the schema we THINK we have?
 *
 * WHY THIS EXISTS. Two columns of `scheduled_calls` had drifted for the life of the table:
 * `lead_id` was NOT NULL in the database while the schema called it nullable, and `provider`
 * defaulted to 'calcom' in the database and 'trafft' in the schema. Both were invisible:
 *
 *   - The TEST SUITE builds tables from the schema, so it tests the schema against itself.
 *   - `drizzle-kit generate` compares the schema to its own SNAPSHOTS, which are generated from
 *     the schema. They agreed with it throughout, which is exactly why they could not catch this.
 *
 * The only honest reference is a database built by replaying every migration in order, which is
 * what production is. `lead_id` surfaced the hard way: a booking was created in a customer's real
 * calendar, the row insert failed on a constraint no test knew about, and a meeting existed that
 * nothing in our system could see.
 *
 * Requires Docker. Read-only with respect to any real database — it builds a throwaway one.
 *
 *   node scripts/check-schema-drift.mjs
 *
 * Exit 0 = no drift. Exit 1 = drift, listed. Exit 2 = could not run the check.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CONTAINER = 'schema-drift-check';
const PORT = 55433;
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
/** A real blocking sleep. `node -e 'setTimeout(...)'` relies on a pending timer holding the event
 *  loop open, which is both indirect and one process spawn per second of waiting. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const psql = (sql) =>
  run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'audit', '-tAF|', '-c', sql]);

function cleanup() {
  try {
    run('docker', ['rm', '-f', CONTAINER]);
  } catch {
    /* never existed */
  }
}

/** Strip the casts and quoting Postgres adds, so 'calcom'::varchar and "calcom" compare equal. */
function normalizeDefault(d) {
  if (d === undefined || d === null || d === '') return null;
  let s = String(d).trim().replace(/::[a-zA-Z_ ".[\]]+$/, '').trim();
  if (/^'(.*)'$/s.test(s) || /^"(.*)"$/s.test(s)) s = s.slice(1, -1);
  const lowered = s.toLowerCase();
  if (lowered === 'now()' || lowered === 'current_timestamp') return 'now()';
  return s;
}

let out;
try {
  run('docker', ['version', '--format', '{{.Server.Version}}']);
} catch {
  console.error('Docker is not available — cannot build a reference database.');
  process.exit(2);
}

cleanup();
try {
  console.log('building a database from the migrations...');
  run('docker', [
    'run', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=audit', '-e', 'POSTGRES_DB=audit',
    '-p', `${PORT}:5432`, 'postgres:16-alpine',
  ]);

  // READINESS IS NOT ONE `pg_isready` (fixed 2026-09-06, on this check's first ever CI run).
  //
  // The official postgres image runs initdb against a TEMPORARY server first, on the unix socket
  // only, then shuts it down and starts the real one. A single `pg_isready` answers 0 against that
  // bootstrap server, and the migrations then land in the gap while it restarts:
  //
  //     psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed:
  //     No such file or directory
  //
  // which is exit 2 ("could not run the check") reported as if the tool were broken rather than
  // the database not being up. On a laptop the container is slow enough that the 1-second retries
  // usually straddle the restart by luck; a CI runner is fast enough to lose that race every time.
  //
  // So: probe with the QUERY the migrations are about to run, not with a liveness ping, and
  // require it to succeed three times in a row — the restart cannot hide inside that.
  let streak = 0;
  for (let i = 0; i < 90 && streak < 3; i++) {
    try {
      run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'audit', '-c', 'select 1']);
      streak += 1;
    } catch {
      streak = 0;
    }
    if (streak < 3) sleep(1000);
  }
  if (streak < 3) throw new Error('postgres never became ready');

  run('docker', ['exec', CONTAINER, 'sh', '-c', 'rm -rf /mig && mkdir -p /mig']);
  run('docker', ['cp', 'src/db/migrations/.', `${CONTAINER}:/mig/`]);
  // ON_ERROR_STOP so a broken migration fails the check rather than half-applying.
  run('docker', [
    'exec', CONTAINER, 'sh', '-c',
    'for f in $(ls /mig/*.sql | sort); do psql -U postgres -d audit -v ON_ERROR_STOP=1 -q -f "$f" || exit 1; done',
  ]);

  const tmp = mkdtempSync(path.join(tmpdir(), 'drift-'));
  try {
    run('npx', [
      'drizzle-kit', 'generate',
      '--schema', './src/db/schema/*.ts',
      '--out', tmp,
      '--dialect', 'postgresql',
    ], { shell: process.platform === 'win32' });
    const snap = JSON.parse(readFileSync(path.join(tmp, 'meta/0000_snapshot.json'), 'utf8'));

    const rows = psql(
      "select table_name, column_name, is_nullable, coalesce(column_default,''), data_type " +
        "from information_schema.columns where table_schema='public' " +
        "and table_name <> '__drizzle_migrations' order by table_name, column_name",
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [table, column, nullable, def] = l.split('|');
        return { table, column, notNull: nullable === 'NO', def };
      });

    const db = new Map(rows.map((r) => [`${r.table}.${r.column}`, r]));
    const findings = [];
    const declared = new Set();

    for (const [key, table] of Object.entries(snap.tables)) {
      const tableName = table.name ?? key.split('.').pop();
      for (const col of Object.values(table.columns)) {
        const id = `${tableName}.${col.name}`;
        declared.add(id);
        const actual = db.get(id);
        if (!actual) {
          findings.push(`MISSING IN DB   ${id} — declared in the schema, no migration creates it`);
          continue;
        }
        if (Boolean(col.notNull) !== actual.notNull) {
          findings.push(
            `NULLABILITY     ${id} — schema=${col.notNull ? 'NOT NULL' : 'nullable'} db=${actual.notNull ? 'NOT NULL' : 'nullable'}`,
          );
        }
        const want = normalizeDefault(col.default);
        const got = normalizeDefault(actual.def);
        if (want !== got && !(got && got.startsWith('nextval('))) {
          findings.push(`DEFAULT         ${id} — schema=${want ?? '(none)'} db=${got ?? '(none)'}`);
        }
      }
    }
    for (const r of rows) {
      const id = `${r.table}.${r.column}`;
      if (!declared.has(id)) findings.push(`EXTRA IN DB     ${id} — built by a migration, absent from the schema`);
    }

    console.log(`\nschema columns: ${declared.size}   database columns: ${rows.length}`);
    if (findings.length === 0) {
      console.log('no drift\n');
      out = 0;
    } else {
      console.log(`\n${findings.length} drift(s):\n`);
      for (const f of findings.sort()) console.log(`  ${f}`);
      console.log('\nFix by writing a migration — never by editing an applied one.\n');
      out = 1;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} catch (err) {
  console.error('check failed:', err instanceof Error ? err.message : err);
  out = 2;
} finally {
  cleanup();
}

process.exit(out);
