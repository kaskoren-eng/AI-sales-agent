import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schedulingRoutes } from './scheduling.routes.js';

/**
 * The cancel endpoint is C1's cleanup path: cancelling a meeting must also remove its pending
 * reminder jobs (found by the ids stored on the row), and a removal failure must never fail
 * the cancellation — the worker's fire-time status check is the backstop.
 */

vi.mock('./providers/google-calendar.provider.js', () => ({
  GoogleCalendarProvider: vi.fn(() => ({
    cancelBooking: vi.fn(async () => undefined),
  })),
}));

function buildTestApp(opts: {
  reminders?: { jobIds: string[] } | null;
  removeImpl?: (id: string) => Promise<number>;
}) {
  const app = Fastify({ logger: false });
  const removed: string[] = [];
  const updates: Record<string, unknown>[] = [];

  app.decorate('env', {
    GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com',
    GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
    GOOGLE_CALENDAR_PRIVATE_KEY: 'key',
  } as unknown as FastifyInstance['env']);
  app.decorate('db', {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.reminders === null ? [] : [{ reminders: opts.reminders }]),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push(vals);
        },
      }),
    })),
  } as unknown as FastifyInstance['db']);
  app.decorate('queues', {
    meetingReminders: {
      remove: vi.fn(async (id: string) => {
        removed.push(id);
        return opts.removeImpl ? opts.removeImpl(id) : 1;
      }),
    },
  } as unknown as FastifyInstance['queues']);
  app.addHook('onRequest', async (request) => {
    (request as { tenantId?: string }).tenantId = 'tenant-1';
  });
  app.register(schedulingRoutes);
  return { app, removed, updates };
}

describe('POST /cancel/:bookingUid — reminder cleanup (C1)', () => {
  afterEach(() => vi.clearAllMocks());

  it('cancels, then removes every reminder job id stored on the row', async () => {
    const { app, removed, updates } = buildTestApp({
      reminders: { jobIds: ['reminder-sc-1-t1440-wa', 'reminder-sc-1-t60-email', 'reminder-sc-1-t60-wa-d1'] },
    });
    const res = await app.inject({ method: 'POST', url: '/cancel/evt-123' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(updates[0]).toMatchObject({ status: 'cancelled' });
    // All three ids removed — including the quiet-hours -d1 deferral copy.
    expect(removed).toEqual([
      'reminder-sc-1-t1440-wa',
      'reminder-sc-1-t60-email',
      'reminder-sc-1-t60-wa-d1',
    ]);
    await app.close();
  });

  it('row with no reminders (pre-C1 bookings) → cancel succeeds, no queue calls', async () => {
    const { app, removed } = buildTestApp({ reminders: null });
    const res = await app.inject({ method: 'POST', url: '/cancel/evt-old' });
    expect(res.statusCode).toBe(200);
    expect(removed).toEqual([]);
    await app.close();
  });

  it('reminder removal failure NEVER fails the cancellation — the worker backstop covers it', async () => {
    const { app, updates } = buildTestApp({
      reminders: { jobIds: ['reminder-sc-1-t60-wa'] },
      removeImpl: async () => {
        throw new Error('redis down');
      },
    });
    const res = await app.inject({ method: 'POST', url: '/cancel/evt-123' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(updates[0]).toMatchObject({ status: 'cancelled' }); // the meeting IS cancelled
    await app.close();
  });
});
