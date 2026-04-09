import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './test/helpers.js';

describe('health check', () => {
  let app: FastifyInstance;

  afterEach(async () => { await app?.close(); });

  it('GET /health returns ok', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('global error handler', () => {
  let app: FastifyInstance;

  afterEach(async () => { await app?.close(); });

  it('returns AppError shape for known errors', async () => {
    app = await buildTestApp({
      registerRoutes: async (a) => {
        const { NotFoundError } = await import('./shared/errors.js');
        a.get('/test-error', async () => { throw new NotFoundError('Widget', 'xyz'); });
      },
    });

    const res = await app.inject({ method: 'GET', url: '/test-error' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NOT_FOUND', message: 'Widget not found: xyz' });
  });

  it('returns 500 for unknown errors', async () => {
    app = await buildTestApp({
      registerRoutes: async (a) => {
        a.get('/boom', async () => { throw new Error('something unexpected'); });
      },
    });

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'INTERNAL_ERROR' });
  });
});
