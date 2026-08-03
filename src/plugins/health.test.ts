import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import healthPlugin, { checkDependency } from './health.js';

/**
 * The regression these pin: /health used to be `async () => ({ status: 'ok' })`. It reported
 * healthy with a dead database, so Railway kept serving from a container that could not answer a
 * single request. Any change that makes /health stop touching its dependencies must fail here.
 */

async function buildHealthApp(opts: {
  dbExecute?: () => Promise<unknown>;
  redisPing?: () => Promise<unknown>;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('db', { execute: opts.dbExecute ?? (async () => [{ '?column?': 1 }]) } as never);
  app.decorate('redis', { ping: opts.redisPing ?? (async () => 'PONG') } as never);
  await app.register(healthPlugin);
  await app.ready();
  return app;
}

describe('checkDependency', () => {
  it('reports ok with a latency when the probe resolves', async () => {
    const result = await checkDependency(async () => 'fine');
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the failure reason when the probe rejects', async () => {
    const result = await checkDependency(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('times out rather than hanging when a dependency never answers', async () => {
    // The real failure mode: a dead Postgres does not refuse the connection, it accepts and
    // never replies. Without the timeout the healthcheck itself hangs and Railway's probe
    // times out with no diagnostic.
    const result = await checkDependency(() => new Promise(() => {}), 20);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });

  it('does not leave a pending timer behind on the happy path', async () => {
    // Regression guard: an uncleared timer keeps the event loop alive for the full timeout,
    // which makes app.close() hang. Fake timers make the leak observable.
    vi.useFakeTimers();
    try {
      const promise = checkDependency(async () => 'fine', 60_000);
      await vi.advanceTimersByTimeAsync(0);
      await promise;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /health/live', () => {
  it('is 200 even when every dependency is down', async () => {
    // Liveness must never depend on Postgres or Redis — otherwise a DB outage gets the process
    // killed and restarted, which cannot possibly fix a DB outage.
    const app = await buildHealthApp({
      dbExecute: async () => {
        throw new Error('down');
      },
      redisPing: async () => {
        throw new Error('down');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('GET /health', () => {
  it('is 200 and actually probes both dependencies when healthy', async () => {
    const dbExecute = vi.fn(async () => [{ '?column?': 1 }]);
    const redisPing = vi.fn(async () => 'PONG');
    const app = await buildHealthApp({ dbExecute, redisPing });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    // The point of the endpoint: it is not allowed to answer without asking.
    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(redisPing).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('is 503 when Postgres is unreachable', async () => {
    const app = await buildHealthApp({
      dbExecute: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
    expect(body.checks.redis.ok).toBe(true);
    await app.close();
  });

  it('is 503 when Redis is unreachable', async () => {
    const app = await buildHealthApp({
      redisPing: async () => {
        throw new Error('connection lost');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks.redis).toMatchObject({ ok: false, error: 'connection lost' });
    expect(body.checks.postgres.ok).toBe(true);
    await app.close();
  });

  it('names every failing dependency rather than stopping at the first', async () => {
    // A degraded response that only mentions Postgres sends the operator chasing one outage
    // when there are two.
    const app = await buildHealthApp({
      dbExecute: async () => {
        throw new Error('pg down');
      },
      redisPing: async () => {
        throw new Error('redis down');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks.postgres.error).toBe('pg down');
    expect(body.checks.redis.error).toBe('redis down');
    await app.close();
  });
});
