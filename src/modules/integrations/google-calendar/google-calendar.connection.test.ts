import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The two things that turn "we stored a Google token" into "the calendar actually works".
 *
 * Google Calendar is mandatory to the product — a sales agent that cannot book a meeting has not
 * done its job — so the failure modes that matter are the SILENT ones:
 *
 *   1. A connection that was never really valid. Storing tokens proves only that Google accepted
 *      an authorisation code. It does not prove we can read a calendar: the consent screen lets a
 *      user untick individual permissions, and the account may have no accessible calendar. Both
 *      produce a dashboard that says "Connected" and a booking that fails mid-call, in front of a
 *      lead.
 *   2. A connection that stopped being valid. The customer revokes us in their Google settings,
 *      changes their password, or lets the grant expire. Bookings stop; the dashboard keeps
 *      saying "Connected"; the first anyone hears of it is an empty diary.
 */

const getToken = vi.fn();
const userinfoGet = vi.fn();
const calendarListGet = vi.fn();
const setCredentials = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = setCredentials;
        getToken = getToken;
        on = vi.fn();
      },
    },
    oauth2: () => ({ userinfo: { get: userinfoGet } }),
    calendar: () => ({ calendarList: { get: calendarListGet } }),
  },
}));

const { GoogleCalendarConnectionService, isInvalidGrant } = await import('./google-calendar.connection.js');

const CONFIG = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://api.example.com/webhooks/google-calendar/callback',
};

function fakeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert: vi.fn(() => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          inserted.push(vals);
        },
      }),
    })),
  } as never;
  return { db, inserted };
}

// AES-256-GCM, and `crypto.ts` hex-DECODES this — so it is 64 hex chars (32 bytes), not 32 chars.
const KEY = 'ab'.repeat(32);

beforeEach(() => {
  getToken.mockReset();
  userinfoGet.mockReset();
  calendarListGet.mockReset();
  getToken.mockResolvedValue({
    tokens: { refresh_token: 'refresh-1', access_token: 'access-1', expiry_date: Date.now() + 3600_000 },
  });
  userinfoGet.mockResolvedValue({ data: { email: 'owner@customer.com' } });
  calendarListGet.mockResolvedValue({ data: { id: 'primary' } });
});

describe('completeConnection proves the grant before storing it', () => {
  it('stores the connection when the calendar can actually be read', async () => {
    const { db, inserted } = fakeDb();
    const service = new GoogleCalendarConnectionService(db, KEY);

    const result = await service.completeConnection(CONFIG, 'tenant-a', 'code-1');

    expect(calendarListGet).toHaveBeenCalledWith({ calendarId: 'primary' });
    expect(result.accountEmail).toBe('owner@customer.com');
    expect(inserted).toHaveLength(1);
    // Tokens are stored as ciphertext, never plaintext.
    expect(JSON.stringify(inserted[0])).not.toContain('refresh-1');
    expect(inserted[0]!.refreshTokenEncrypted).toBeTruthy();
  });

  it('REFUSES to store a connection whose calendar cannot be read', async () => {
    // The user unticked calendar access on the consent screen. Google still returns tokens, so
    // without this check the dashboard would say "Connected" and the first booking of the first
    // real call would fail.
    const { db, inserted } = fakeDb();
    const service = new GoogleCalendarConnectionService(db, KEY);
    calendarListGet.mockRejectedValue(new Error('Request had insufficient authentication scopes.'));

    await expect(service.completeConnection(CONFIG, 'tenant-a', 'code-1')).rejects.toThrow(
      /calendar could not be read/i,
    );
    // Nothing stored — a connection that cannot read the calendar is worse than none, because it
    // silences the "connect your calendar" prompt.
    expect(inserted).toHaveLength(0);
  });

  it('refuses a grant with no refresh token rather than storing one that dies in an hour', async () => {
    const { db, inserted } = fakeDb();
    const service = new GoogleCalendarConnectionService(db, KEY);
    getToken.mockResolvedValue({ tokens: { access_token: 'access-only' } });

    await expect(service.completeConnection(CONFIG, 'tenant-a', 'code-1')).rejects.toThrow(/refresh token/i);
    expect(inserted).toHaveLength(0);
  });

  it('does not fail the connection just because the account label could not be fetched', async () => {
    // Knowing WHICH account is linked is a nicety. Losing it must not cost the customer a working
    // calendar.
    const { db, inserted } = fakeDb();
    const service = new GoogleCalendarConnectionService(db, KEY);
    userinfoGet.mockRejectedValue(new Error('userinfo unavailable'));

    const result = await service.completeConnection(CONFIG, 'tenant-a', 'code-1');
    expect(result.accountEmail).toBeNull();
    expect(inserted).toHaveLength(1);
  });
});

describe('isInvalidGrant', () => {
  it('recognises the shapes googleapis actually throws', () => {
    // The same failure surfaces differently depending on where in the client it threw, and getting
    // this wrong means a revoked customer is never told to reconnect.
    expect(isInvalidGrant(new Error('invalid_grant'))).toBe(true);
    expect(isInvalidGrant({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
    expect(isInvalidGrant({ data: { error: 'invalid_grant' } })).toBe(true);
    expect(isInvalidGrant({ error: 'invalid_grant' })).toBe(true);
    expect(isInvalidGrant({ error: { message: 'invalid_grant: Token has been expired or revoked.' } })).toBe(true);
  });

  it('does not mistake a transient failure for a dead grant', () => {
    // Marking a healthy connection revoked would tell a customer to reconnect a calendar that is
    // fine — and, worse, teach them to ignore the warning.
    expect(isInvalidGrant(new Error('Rate Limit Exceeded'))).toBe(false);
    expect(isInvalidGrant(new Error('Backend Error'))).toBe(false);
    expect(isInvalidGrant({ code: 503 })).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
    expect(isInvalidGrant(undefined)).toBe(false);
    expect(isInvalidGrant('invalid_grant')).toBe(false); // a bare string is not an error object
  });
});
