import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';

/**
 * TWO endpoints, because they answer different questions and conflating them is how a database
 * blip turns into a restart loop:
 *
 *   /health/live  — "is this process alive?"  Never touches a dependency. Restarting on a failure
 *                   here is always right, because only the process itself can be wrong.
 *   /health       — "can this process serve traffic?"  Checks Postgres and Redis. Railway probes
 *                   this one (railway.toml healthcheckPath), so a deploy that cannot reach its
 *                   database never gets promoted. Restart policy is on_failure/max 3, so an
 *                   outage costs a bounded number of restarts rather than an unbounded loop.
 *
 * Until this landed, /health was `async () => ({ status: 'ok' })` — it never opened a socket to
 * anything. Railway kept containers in rotation with a dead DB and a dead Redis, serving 500s to
 * every request while reporting itself healthy.
 */
const HEALTH_DEP_TIMEOUT_MS = 2_000;

export interface DependencyCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function checkDependency(
  probe: () => Promise<unknown>,
  timeoutMs = HEALTH_DEP_TIMEOUT_MS,
): Promise<DependencyCheck> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Without this a fast, healthy probe still holds the event loop open for the full timeout,
    // which makes app.close() hang in tests and delays shutdown in production.
    if (timer) clearTimeout(timer);
  }
}

export default fp(async (app) => {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      checkDependency(() => app.db.execute(sql`SELECT 1`)),
      checkDependency(() => app.redis.ping()),
    ]);

    const healthy = postgres.ok && redis.ok;
    // 503, not 500: "temporarily unable to serve" is what load balancers and orchestrators are
    // built to interpret.
    if (!healthy) reply.status(503);
    return { status: healthy ? 'ok' : 'degraded', checks: { postgres, redis } };
  });
}, { name: 'health' });
