import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHOSE CALENDAR DOES THE REST API BOOK INTO.
 *
 * These routes used to build their Google client straight from `GOOGLE_CALENDAR_*` env and pass
 * `serviceId: env.GOOGLE_CALENDAR_ID` on every call. Those env vars are ClickScales' own
 * credentials, so a customer booking through the API had their meeting created in ClickScales'
 * diary while the `scheduled_calls` row was written with the CUSTOMER's tenant_id — the database
 * and the calendar disagreeing, with nothing to reconcile them. `/slots` had the mirror-image
 * problem: customers were shown ClickScales' free time.
 *
 * The voice agent had resolved this correctly per tenant since Phase 4, which is what made the
 * gap easy to miss — the same product answered "whose calendar" differently depending on whether
 * a booking arrived by phone or by HTTP.
 *
 * The invariant these tests defend: a tenant books with ITS OWN credentials into ITS OWN
 * calendar, or it does not book at all. There is no third case, and in particular no quiet fall
 * back to the platform account.
 */

const constructed: Array<Record<string, unknown>> = [];
const createBooking = vi.fn(async (args: { serviceId: string }) => ({
  uid: 'evt-1',
  start: '2026-09-01T09:00:00.000Z',
  serviceId: args.serviceId,
}));
const getAvailableSlots = vi.fn(async () => [{ start: '2026-09-01T09:00:00.000Z' }]);

vi.mock('./providers/google-calendar.provider.js', () => ({
  GoogleCalendarProvider: vi.fn((config: Record<string, unknown>) => {
    constructed.push(config);
    return { createBooking, getAvailableSlots, cancelBooking: vi.fn(async () => undefined) };
  }),
}));

/** The connection lookup, stubbed at the source so `resolveCalendarAuth` itself runs for real. */
let storedConnection: Record<string, unknown> | null = null;
vi.mock('../integrations/google-calendar/google-calendar.connection.js', () => ({
  GoogleCalendarConnectionService: vi.fn(() => ({
    get: vi.fn(async () => storedConnection),
  })),
  toProviderAuth: vi.fn((client: Record<string, unknown>, connection: Record<string, unknown>) => ({
    kind: 'oauth',
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken: connection.refreshToken,
  })),
}));

const { schedulingRoutes } = await import('./scheduling.routes.js');

const PLATFORM = 'platform-tenant';
const CUSTOMER = 'customer-tenant';

const PLATFORM_ENV = {
  PLATFORM_TENANT_ID: PLATFORM,
  ENCRYPTION_KEY: 'k'.repeat(64),
  GOOGLE_CALENDAR_ID: 'clickscales@group.calendar.google.com',
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
  GOOGLE_CALENDAR_PRIVATE_KEY: 'key',
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: 'https://example.test/callback',
};

const inserted: Array<Record<string, unknown>> = [];

function buildApp(tenantId: string, envOverrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  app.decorate('env', { ...PLATFORM_ENV, ...envOverrides } as unknown as FastifyInstance['env']);
  app.decorate('db', {
    insert: vi.fn(() => ({
      values: async (v: Record<string, unknown>) => {
        inserted.push(v);
      },
    })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  } as unknown as FastifyInstance['db']);
  app.decorate('queues', {
    meetingReminders: { remove: vi.fn() },
  } as unknown as FastifyInstance['queues']);
  app.addHook('onRequest', async (request) => {
    (request as { tenantId?: string }).tenantId = tenantId;
  });
  app.register(schedulingRoutes);
  return app;
}

const BOOKING = {
  start: '2026-09-01T09:00:00.000Z',
  name: 'Test Lead',
  email: 'lead@example.test',
};

let app: FastifyInstance;

beforeEach(() => {
  constructed.length = 0;
  inserted.length = 0;
  storedConnection = null;
  createBooking.mockClear();
  getAvailableSlots.mockClear();
});

afterEach(async () => {
  await app?.close();
});

describe('POST /book - the calendar a booking lands in', () => {
  it('refuses a customer with no connected calendar instead of using ClickScales', async () => {
    // The whole bug in one assertion. Before the fix this returned 201 and put a stranger's
    // meeting in Koren's diary; the customer saw a confirmed booking, and nobody saw the mix-up
    // until someone happened to open the wrong calendar.
    app = buildApp(CUSTOMER);

    const res = await app.inject({ method: 'POST', url: '/book', payload: BOOKING });

    expect(res.statusCode).toBe(503);
    expect(createBooking).not.toHaveBeenCalled();
    // And critically: no scheduled_calls row claiming a meeting that exists in no calendar.
    expect(inserted).toHaveLength(0);
  });

  it('books a connected customer into their own calendar with their own credentials', async () => {
    storedConnection = { calendarId: 'customer@group.calendar.google.com', refreshToken: 'rt' };
    app = buildApp(CUSTOMER);

    const res = await app.inject({ method: 'POST', url: '/book', payload: BOOKING });

    expect(res.statusCode).toBe(201);
    // Both halves matter: the right calendar AND the right credentials. Booking a customer's
    // calendar with the platform service account fails outright — it has no rights there.
    expect(createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'customer@group.calendar.google.com' }),
    );
    expect(constructed[0]).toMatchObject({
      calendarId: 'customer@group.calendar.google.com',
      auth: expect.objectContaining({ kind: 'oauth', refreshToken: 'rt' }),
    });
    expect(inserted[0]).toMatchObject({ tenantId: CUSTOMER });
  });

  it('leaves ClickScales on its service account, so the live tenant is unchanged', async () => {
    // The fix must not alter the one tenant already in production: same calendar, same credential
    // kind, same path it has used since day one.
    app = buildApp(PLATFORM);

    const res = await app.inject({ method: 'POST', url: '/book', payload: BOOKING });

    expect(res.statusCode).toBe(201);
    expect(constructed[0]).toMatchObject({
      calendarId: 'clickscales@group.calendar.google.com',
      auth: expect.objectContaining({ kind: 'service_account' }),
    });
  });

  it('never treats the platform env as a fallback, even when it is fully configured', async () => {
    // PLATFORM_TENANT_ID is set and every GOOGLE_CALENDAR_* var is present. A customer with no
    // connection still gets nothing: "configured" must never mean "available to everyone".
    app = buildApp(CUSTOMER);

    const res = await app.inject({ method: 'POST', url: '/book', payload: BOOKING });

    expect(res.statusCode).toBe(503);
    expect(constructed).toHaveLength(0);
  });
});

describe('GET /slots - the calendar availability is read from', () => {
  it('reads the connected customer calendar rather than ClickScales', async () => {
    // The mirror of the booking bug, and the one a customer notices first: offered slots that are
    // really the vendor's free time, so every meeting collides with something they cannot see.
    storedConnection = { calendarId: 'customer@group.calendar.google.com', refreshToken: 'rt' };
    app = buildApp(CUSTOMER);

    const res = await app.inject({
      method: 'GET',
      url: '/slots?startDate=2026-09-01&endDate=2026-09-02',
    });

    expect(res.statusCode).toBe(200);
    expect(getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'customer@group.calendar.google.com' }),
    );
  });

  it('refuses rather than offering someone elses free time', async () => {
    app = buildApp(CUSTOMER);

    const res = await app.inject({
      method: 'GET',
      url: '/slots?startDate=2026-09-01&endDate=2026-09-02',
    });

    expect(res.statusCode).toBe(503);
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });
});
