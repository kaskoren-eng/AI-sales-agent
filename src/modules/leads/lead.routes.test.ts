import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createMockDb } from '../../test/helpers.js';
import { leadRoutes } from './lead.routes.js';

const TENANT = 'tenant-test-uuid'; // matches test token in helpers
const LEAD_ID = 'lead-uuid-1';

const SAMPLE_LEAD = {
  id: LEAD_ID,
  tenantId: TENANT,
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+1234567890',
  status: 'new',
  score: 0,
  source: 'manual',
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeQueryBuilder(rows: any[]) {
  const b: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
    returning: vi.fn().mockResolvedValue(rows),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
  };
  return b;
}

const AUTH = { authorization: 'Bearer test-token' };

/**
 * Register lead routes the same way the real server does:
 * auth hook on a single scope, routes registered one level below.
 * Avoids extra anonymous scope so root error handler is reachable.
 */
function withLeadRoutes(db: ReturnType<typeof createMockDb>) {
  return {
    db,
    registerRoutes: async (a: FastifyInstance) => {
      a.addHook('onRequest', a.authenticate);
      await a.register(leadRoutes, { prefix: '/api/v1/leads' });
    },
  };
}

describe('lead routes', () => {
  let app: FastifyInstance;

  afterEach(async () => { await app?.close(); });

  it('POST / creates a lead and returns 201', async () => {
    const db = createMockDb();
    const builder = makeQueryBuilder([SAMPLE_LEAD]);
    db.insert.mockReturnValue(builder);
    // Metering runs on this path and logs against a bare mock; the next test is the one that
    // asserts on that. Silenced here so it does not drown the output of a genuine failure.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    app = await buildTestApp(withLeadRoutes(db));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com' }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe(LEAD_ID);
  });

  it('still creates the lead when usage metering fails', async () => {
    // Creating a lead is the customer's core product event. A counter that cannot be written must
    // never be able to fail it — that would trade a recoverable accounting gap (reconcilable from
    // the `leads` table itself) for an unrecoverable business one.
    //
    // This db mock has no `select` configured, so the meter's period lookup throws. The route must
    // not notice. It must, however, be LOUD about it: the log line is the signal that
    // `npm run usage:reconcile` has work to do, and silence there would make under-billing
    // undetectable.
    const db = createMockDb();
    db.insert.mockReturnValue(makeQueryBuilder([SAMPLE_LEAD]));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    app = await buildTestApp(withLeadRoutes(db));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com' }),
    });

    expect(res.statusCode).toBe(201);
    expect(logged).toHaveBeenCalledWith('usage_meter_failed', expect.stringContaining(LEAD_ID));
    logged.mockRestore();
  });

  it('GET / lists leads', async () => {
    const db = createMockDb();
    // list() issues two selects: count first, then the page of data
    const countBuilder: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ value: 1 }]),
    };
    const dataBuilder: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockResolvedValue([SAMPLE_LEAD]),
    };
    db.select.mockReturnValueOnce(countBuilder).mockReturnValueOnce(dataBuilder);

    app = await buildTestApp(withLeadRoutes(db));

    const res = await app.inject({ method: 'GET', url: '/api/v1/leads', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().meta).toEqual({ page: 1, limit: 20, total: 1, total_pages: 1 });
  });

  it('GET /:id returns the lead', async () => {
    const db = createMockDb();
    db.select.mockReturnValue(makeQueryBuilder([SAMPLE_LEAD]));

    app = await buildTestApp(withLeadRoutes(db));

    const res = await app.inject({ method: 'GET', url: `/api/v1/leads/${LEAD_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(LEAD_ID);
  });

  it('GET /:id returns 404 with NOT_FOUND code when not found', async () => {
    const db = createMockDb();
    db.select.mockReturnValue(makeQueryBuilder([]));

    app = await buildTestApp(withLeadRoutes(db));

    const res = await app.inject({ method: 'GET', url: '/api/v1/leads/missing', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
    expect(res.json().message).toContain('missing');
  });

  it('returns 401 without auth header', async () => {
    const db = createMockDb();
    app = await buildTestApp(withLeadRoutes(db));

    const res = await app.inject({ method: 'GET', url: '/api/v1/leads' });
    expect(res.statusCode).toBe(401);
  });
});
