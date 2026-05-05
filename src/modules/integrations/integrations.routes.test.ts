import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createMockDb } from '../../test/helpers.js';

// ── Service mocks ─────────────────────────────────────────────────────────────
vi.mock('./csv-import.service.js', () => ({
  CsvImportService: vi.fn().mockImplementation(() => ({
    importFromCsv: vi.fn().mockResolvedValue({ jobId: 'mock-job-id' }),
  })),
}));

import { integrationsRoutes } from './integrations.routes.js';

const AUTH = { authorization: 'Bearer test-token' };
const TENANT_ID = 'tenant-test-uuid'; // matches test token in helpers

const IMPORT_JOB = {
  id: 'job-uuid-1',
  tenantId: TENANT_ID,
  source: 'csv',
  status: 'completed',
  totalRows: 10,
  processedRows: 10,
  errors: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function withIntegrationRoutes(db: ReturnType<typeof createMockDb>) {
  return {
    db,
    registerRoutes: async (app: FastifyInstance) => {
      app.addHook('onRequest', app.authenticate);
      await app.register(integrationsRoutes, { prefix: '/api/v1/integrations' });
    },
  };
}

describe('integrations routes', () => {
  let app: FastifyInstance;

  afterEach(async () => { await app?.close(); });

  // ── Auth enforcement ────────────────────────────────────────────────────────

  it('returns 401 on all routes when auth is missing', async () => {
    const db = createMockDb();
    app = await buildTestApp(withIntegrationRoutes(db));

    for (const [method, url] of [
      ['POST', '/api/v1/integrations/import'],
      ['GET',  '/api/v1/integrations/import/some-id'],
      ['POST', '/api/v1/integrations/google-sheets/connect'],
      ['POST', '/api/v1/integrations/google-sheets/sync'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url} should be 401`).toBe(401);
    }
  });

  // ── POST /import ────────────────────────────────────────────────────────────

  it('POST /import returns 202 with jobId on valid CSV content', async () => {
    const db = createMockDb();
    app = await buildTestApp(withIntegrationRoutes(db));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/import',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ csvContent: 'name,email\nAlice,alice@example.com' }),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ jobId: 'mock-job-id' });
  });

  it('POST /import returns 400 when csvContent is missing', async () => {
    const db = createMockDb();
    app = await buildTestApp(withIntegrationRoutes(db));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/import',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /import returns 400 when csvContent is empty string', async () => {
    const db = createMockDb();
    app = await buildTestApp(withIntegrationRoutes(db));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/import',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ csvContent: '' }),
    });

    expect(res.statusCode).toBe(400);
  });

  // ── GET /import/:jobId ──────────────────────────────────────────────────────

  it('GET /import/:jobId returns job status', async () => {
    const db = createMockDb();
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([IMPORT_JOB]),
    };
    db.select.mockReturnValue(chain);

    app = await buildTestApp(withIntegrationRoutes(db));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/import/${IMPORT_JOB.id}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: IMPORT_JOB.id,
      status: 'completed',
      totalRows: 10,
      processedRows: 10,
    });
  });

  it('GET /import/:jobId returns 404 when job not found', async () => {
    const db = createMockDb();
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    db.select.mockReturnValue(chain);

    app = await buildTestApp(withIntegrationRoutes(db));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations/import/not-a-real-id',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });

  // ── POST /google-sheets/connect ─────────────────────────────────────────────

  it('POST /google-sheets/connect returns 501 NOT_IMPLEMENTED', async () => {
    const db = createMockDb();
    app = await buildTestApp(withIntegrationRoutes(db));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google-sheets/connect',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms' }),
    });

    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('NOT_IMPLEMENTED');
  });

  // ── POST /google-sheets/sync ────────────────────────────────────────────────

  it('POST /google-sheets/sync returns 501 NOT_IMPLEMENTED', async () => {
    const db = createMockDb();
    app = await buildTestApp(withIntegrationRoutes(db));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google-sheets/sync',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('NOT_IMPLEMENTED');
  });
});
