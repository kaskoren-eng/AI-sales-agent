import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { zadarmaRoutes } from './zadarma.routes.js';

/**
 * These handlers used to live inside the legacy Retell channel module and were extracted when
 * that module was deleted (2026-08-05). They are engine-independent — they belong to the
 * conference-monitoring path, not to any voice agent.
 *
 * The URL is the contract: it is registered in the Zadarma portal, so it must stay mounted at
 * `/webhooks/voice/zadarma`. If that prefix ever changes, recordings stop being analyzed and
 * nothing in the system reports an error — the webhook simply 404s into the void.
 */

const enqueued: unknown[] = [];
vi.mock('../../../queues/call-analysis.queue.js', () => ({
  enqueueCallAnalysis: vi.fn(async (_q: unknown, data: unknown) => {
    enqueued.push(data);
  }),
}));

function buildTestApp(opts: { mapping?: string | null; learningRow?: { id: string } | null } = {}) {
  const app = Fastify({ logger: false });
  const updates: Record<string, unknown>[] = [];

  app.decorate('db', {
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push(vals);
        },
      }),
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.learningRow === null ? [] : [opts.learningRow ?? { id: 'learning-1' }]),
        }),
      }),
    })),
  } as unknown as FastifyInstance['db']);

  app.decorate('redis', {
    get: vi.fn(async () => (opts.mapping === undefined ? JSON.stringify({ tenantId: 'tenant-1' }) : opts.mapping)),
  } as unknown as FastifyInstance['redis']);

  app.decorate('queues', { callAnalysis: {} } as unknown as FastifyInstance['queues']);

  // Same urlencoded parser the webhook scope installs in server.ts — Zadarma POSTs form data,
  // and without this the route 415s before the handler ever runs.
  app.addContentTypeParser('application/x-www-form-urlencoded', { bodyLimit: 262_144 }, (_req, body, done) => {
    let data = '';
    body.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    body.on('end', () => {
      done(null, Object.fromEntries(new URLSearchParams(data)));
    });
  });

  // Mounted exactly as server.ts mounts it.
  app.register(zadarmaRoutes, { prefix: '/webhooks/voice' });
  return { app, updates };
}

describe('zadarma webhooks — survived the legacy voice module deletion', () => {
  it('GET /webhooks/voice/zadarma?zd_echo=<v> returns the value as plain text', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/webhooks/voice/zadarma?zd_echo=abc123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('abc123');
    expect(res.headers['content-type']).toMatch(/text\/plain/u);
  });

  it('GET without the echo param still 200s', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/webhooks/voice/zadarma' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST an answered call with a recording → enqueues analysis', async () => {
    enqueued.length = 0;
    const { app, updates } = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/voice/zadarma',
      payload: 'call_id=call-1&disposition=answered&recording=https://rec/1.mp3&duration=42',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(200);
    expect(updates[0]).toEqual({ recordingUrl: 'https://rec/1.mp3' });
    expect(enqueued[0]).toMatchObject({
      tenantId: 'tenant-1',
      learningId: 'learning-1',
      recordingUrl: 'https://rec/1.mp3',
      durationSecs: 42,
    });
  });

  it('POST an unanswered call → 204, nothing enqueued', async () => {
    enqueued.length = 0;
    const { app } = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/voice/zadarma',
      payload: 'call_id=call-1&disposition=busy',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(204);
    expect(enqueued).toHaveLength(0);
  });

  it('POST for a call with no monitor mapping → skipped, never enqueued', async () => {
    enqueued.length = 0;
    const { app } = buildTestApp({ mapping: null });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/voice/zadarma',
      payload: 'call_id=unknown&disposition=answered&recording=https://rec/1.mp3',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, skipped: true });
    expect(enqueued).toHaveLength(0);
  });
});
