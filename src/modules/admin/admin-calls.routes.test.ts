/**
 * The load-bearing test here is the first one.
 *
 * These routes are guarded by a hook that lives in `admin.routes.ts`, not in the file that defines
 * them. Register them one level up by mistake and you get an unauthenticated, cross-tenant endpoint
 * serving call transcripts — which typechecks, starts, and works perfectly in manual testing. So
 * the auth is asserted from the outside, through the real plugin, on every route.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../test/helpers.js';
import { adminRoutes } from './admin.routes.js';

const KEY = 'test-admin-key';

/** Rows are shaped by whichever query ran; these routes only ever read one table. */
function mockDb(rows: unknown[]) {
  const builder = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return { select: vi.fn().mockReturnValue(builder) } as never;
}

async function appWith(rows: unknown[], adminKey: string | undefined = KEY) {
  return buildTestApp({
    db: mockDb(rows),
    ...(adminKey === undefined ? {} : { envOverrides: { ADMIN_API_KEY: adminKey } }),
    registerRoutes: async (a: FastifyInstance) => {
      // Registered exactly as server.ts does it: the whole admin plugin, guard included.
      await a.register(adminRoutes, { prefix: '/api/v1/admin' });
    },
  });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const ROW = {
  id: 'learning-1',
  tenantId: 'tenant-1',
  tenantName: 'ClickScales',
  room: 'room-abc',
  createdAt: new Date('2026-09-06T10:00:00.000Z'),
  durationSecs: 120,
  status: 'pending',
  outcome: null,
  recordingUrl: null,
  callReport: null,
  endReason: null,
  hasReport: false,
};

describe('admin call routes are behind the operator key', () => {
  const paths = ['/api/v1/admin/calls', '/api/v1/admin/calls/learning-1/report'];

  it('refuses both routes with no credentials at all', async () => {
    app = await appWith([ROW]);
    for (const url of paths) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('refuses both routes with the wrong key', async () => {
    app = await appWith([ROW]);
    for (const url of paths) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer nope' } });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('503s when the console is not configured at all, rather than letting anyone in', async () => {
    app = await appWith([ROW], '');
    const res = await app.inject({ method: 'GET', url: paths[0]!, headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /admin/calls', () => {
  it('returns the collection wrapper the console expects', async () => {
    app = await appWith([ROW]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/calls',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0]).toMatchObject({ learningId: 'learning-1', hasReport: false });
  });
});

describe('GET /admin/calls/:id/report', () => {
  it('404s an id that matches nothing', async () => {
    app = await appWith([]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/calls/missing/report',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200s a real call that stored no report, and says so', async () => {
    // Not a 404: the call happened. "We have no report for this one" is the true answer, and it is
    // the one the page has to print instead of a figure strip of zeros.
    app = await appWith([ROW]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/calls/learning-1/report',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ report: null, absence: 'no_report' });
  });

  it('serves a summary key no schema has ever heard of', async () => {
    // The regression test for adding a fastify response schema here: the serializer would drop
    // `someFutureCounter` silently, and the page would show a call that never recorded it.
    app = await appWith([
      { ...ROW, callReport: { summary: { someFutureCounter: 7 }, metrics: [], transcript: [] } },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/calls/learning-1/report',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.json().report.raw.summary.someFutureCounter).toBe(7);
  });
});
