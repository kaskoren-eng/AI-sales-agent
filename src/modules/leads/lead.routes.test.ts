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

  it('GET / lists leads', async () => {
    const db = createMockDb();
    db.select.mockReturnValue(makeQueryBuilder([SAMPLE_LEAD]));

    app = await buildTestApp(withLeadRoutes(db));

    const res = await app.inject({ method: 'GET', url: '/api/v1/leads', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
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
