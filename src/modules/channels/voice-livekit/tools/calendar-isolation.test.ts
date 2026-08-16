import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../../config/env.js';
import type { Database } from '../../../../db/client.js';
import { resolveCalendarAuth } from './tool-context.js';

/**
 * WHOSE CALENDAR DOES A BOOKING GO INTO.
 *
 * Bookings used to be made with one set of credentials read from `GOOGLE_CALENDAR_*` env, for every
 * tenant. So customer #2's agent would qualify a lead, agree a time, call `book_meeting` — and
 * write the meeting into ClickScales' calendar.
 *
 * Nothing errors in that scenario. The tool returns success, the agent tells the lead the meeting
 * is booked, `scheduled_calls` gets a row, and a reminder is scheduled. The only symptom is that
 * the customer's salesperson never sees the meeting and ClickScales sees a stranger's. That is why
 * these assertions are worth more than the code they cover: the bug is invisible from every side
 * except the customer's diary.
 *
 * The rule: a tenant's OWN connection, or the platform service account for ClickScales alone, or
 * NOTHING. There is deliberately no fallback from "not connected" to the platform credentials.
 */

const PLATFORM = '00000000-0000-4000-8000-000000000001';
const CUSTOMER = '00000000-0000-4000-8000-000000000002';

const env = {
  PLATFORM_TENANT_ID: PLATFORM,
  GOOGLE_CALENDAR_ID: 'clickscales@group.calendar.google.com',
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
  GOOGLE_CALENDAR_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: 'https://api.example.com/webhooks/google-calendar/callback',
  ENCRYPTION_KEY: 'k'.repeat(32),
} as unknown as Env;

const db = {} as Database;

const customerCalendar = {
  calendarId: 'customer@example.com',
  auth: {
    kind: 'oauth' as const,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'their-refresh-token',
  },
};

describe('resolveCalendarAuth', () => {
  it('a customer with no connected calendar gets NOTHING — never ClickScales\'', async () => {
    // THE ONE THAT MATTERS. Every credential the platform owns is present in env; none of it may
    // be handed to a tenant who has not connected their own.
    const result = await resolveCalendarAuth(env, CUSTOMER, db, {
      loadCalendarConnection: async () => null,
    });
    expect(result).toBeNull();
  });

  it('a customer WITH a connection books into their own calendar', async () => {
    const result = await resolveCalendarAuth(env, CUSTOMER, db, {
      loadCalendarConnection: async () => customerCalendar,
    });
    expect(result?.calendarId).toBe('customer@example.com');
    expect(result?.source).toBe('tenant_oauth');
    expect(result?.auth.kind).toBe('oauth');
  });

  it('ClickScales still uses its service account, so nothing changes for the live tenant', async () => {
    const result = await resolveCalendarAuth(env, PLATFORM, db, {
      loadCalendarConnection: async () => null,
    });
    expect(result?.calendarId).toBe('clickscales@group.calendar.google.com');
    expect(result?.source).toBe('platform_service_account');
    expect(result?.auth.kind).toBe('service_account');
  });

  it('unescapes the PEM newlines the env var stores literally', async () => {
    const result = await resolveCalendarAuth(env, PLATFORM, db, {
      loadCalendarConnection: async () => null,
    });
    const auth = result!.auth as Extract<NonNullable<typeof result>['auth'], { kind: 'service_account' }>;
    expect(auth.privateKey).toContain('\n');
    expect(auth.privateKey).not.toContain('\\n');
  });

  it('a tenant connection wins even for the platform tenant', async () => {
    // If ClickScales ever connects a real Google account, that is a deliberate act and should
    // out-rank the service account rather than being silently ignored.
    const result = await resolveCalendarAuth(env, PLATFORM, db, {
      loadCalendarConnection: async () => customerCalendar,
    });
    expect(result?.source).toBe('tenant_oauth');
  });

  it('refuses when the platform env is incomplete, rather than half-building a provider', async () => {
    const broken = { ...env, GOOGLE_CALENDAR_PRIVATE_KEY: undefined } as unknown as Env;
    const result = await resolveCalendarAuth(broken, PLATFORM, db, {
      loadCalendarConnection: async () => null,
    });
    expect(result).toBeNull();
  });

  it('a failing connection lookup disables tools rather than falling back to the platform', async () => {
    // A DB blip must not silently reroute a customer's meetings into ClickScales' diary. Losing
    // booking for one call is recoverable; a meeting in the wrong company's calendar is not.
    const result = await resolveCalendarAuth(env, CUSTOMER, db, {
      loadCalendarConnection: async () => {
        throw new Error('connection lookup exploded');
      },
    });
    expect(result).toBeNull();
  });

  it('a hanging lookup does not hang the call', async () => {
    // The greeting waits on this. A calendar lookup that never returns would leave a real caller
    // listening to silence, which is worse than a call with no booking tool.
    const result = await resolveCalendarAuth(env, CUSTOMER, db, {
      loadCalendarConnection: () => new Promise(() => {}),
    });
    expect(result).toBeNull();
  }, 10_000);

  it('a customer whose connection exists but whose OAuth client is unconfigured gets nothing', async () => {
    // The server has no OAuth app configured, so the stored refresh token cannot be exchanged.
    // Falling back to the service account here would put their meeting in ClickScales' calendar.
    const noOauth = {
      ...env,
      GOOGLE_CALENDAR_OAUTH_CLIENT_ID: undefined,
      GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: undefined,
    } as unknown as Env;
    const result = await resolveCalendarAuth(noOauth, CUSTOMER, db, {
      loadCalendarConnection: async () => null,
    });
    expect(result).toBeNull();
  });
});

describe('two tenants, one process', () => {
  it('resolves different calendars for concurrent calls', async () => {
    // The agent forks a child per call, but the API and workers do not — a shared-state mistake
    // here would be a booking written into whichever tenant resolved last.
    const other = { ...customerCalendar, calendarId: 'other@example.com' };
    const lookup = vi.fn(async (_db: Database, tenantId: string) =>
      tenantId === CUSTOMER ? customerCalendar : other,
    );

    const [a, b] = await Promise.all([
      resolveCalendarAuth(env, CUSTOMER, db, { loadCalendarConnection: lookup }),
      resolveCalendarAuth(env, 'tenant-three', db, { loadCalendarConnection: lookup }),
    ]);

    expect(a?.calendarId).toBe('customer@example.com');
    expect(b?.calendarId).toBe('other@example.com');
  });
});
