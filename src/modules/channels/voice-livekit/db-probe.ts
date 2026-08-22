import { sql } from 'drizzle-orm';
import { createDatabase } from '../../../db/client.js';

/**
 * CAN THIS WORKER REACH ITS DATABASE? Ask once, at boot, and say so either way.
 *
 * This exists because of a six-day outage that produced no signal at all. The cloud agent was
 * created with a laptop secrets file — `DATABASE_URL=localhost:5432` — and inside a container
 * `localhost` is the container. Every query failed, and nothing anywhere said so, because three
 * individually correct decisions compose into silence:
 *
 *   - `new Pool()` does not connect eagerly, so construction succeeds against any hostname.
 *   - The tool gate is fail-closed, so a failed read legitimately means "tools off, call
 *     proceeds" — correct for an absent flag, and indistinguishable from an absent database.
 *   - Per-call teardown writes are best-effort by design, so the missing `call_learnings` rows
 *     were swallowed too.
 *
 * Each of those is right on its own. Together they mean a totally broken configuration looks
 * exactly like a quiet week: the system was working as designed, and the design had no way to
 * notice. What was missing was not a guard — the guards did their job — but a voice.
 *
 * So: one round trip per worker boot, not per call, on a path where no caller is waiting.
 *
 * IT MUST NEVER THROW. It runs inside `prewarm`, so throwing would stop the worker starting and
 * turn a degraded agent — which the fail-closed gates already handle safely — into no agent at
 * all. A diagnostic that can take down the thing it diagnoses is worse than no diagnostic.
 */
export async function probeDatabase(databaseUrl: string): Promise<void> {
  const started = Date.now();

  // Host, never the URL: this line is meant to be pasted into an incident thread.
  let host = 'unparseable';
  try {
    host = new URL(databaseUrl).host;
  } catch {
    /* keep the placeholder — a malformed URL is itself worth printing */
  }

  let pool: { end: () => Promise<void> } | undefined;
  try {
    const created = createDatabase(databaseUrl);
    pool = created.pool;
    await created.db.execute(sql`select 1`);
    console.log('agent_db_ok', JSON.stringify({ host, ms: Date.now() - started }));
  } catch (err) {
    console.error(
      'agent_db_unreachable',
      JSON.stringify({
        host,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        impact:
          'no tools, no call_learnings rows, no metering; inbound calls cannot be routed to a tenant and will be refused',
        fix: 'the cloud agent needs Railway PUBLIC endpoints — run: node scripts/fix-agent-secrets.mjs',
      }),
    );
  } finally {
    await pool?.end().catch(() => undefined);
  }
}
