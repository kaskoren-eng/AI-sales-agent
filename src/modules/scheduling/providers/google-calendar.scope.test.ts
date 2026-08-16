import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * TWO TENANTS, TWO CALENDARS, TWO SETS OF CONSEQUENCES.
 *
 * `GoogleCalendarProvider` carried two pieces of process-wide state that were correct for exactly
 * one customer and became cross-tenant bugs the moment there were two:
 *
 *   - `attendeeInvitesBlocked`, a static boolean. The first service-account tenant to hit Google's
 *     "service accounts cannot invite attendees" 403 would permanently disable attendee invites
 *     for EVERY tenant in the worker — including OAuth tenants who can invite attendees perfectly
 *     well. Their leads would quietly stop receiving calendar invitations.
 *   - a module-level circuit breaker. One tenant revoking our calendar access would open the
 *     breaker for everybody, so a healthy tenant could not book for the next thirty seconds
 *     because of a problem in somebody else's Google account.
 *
 * Both are now keyed by credential scope. These tests exist because neither failure produces an
 * error in the affected tenant's own logs — it just silently does less.
 */

const insert = vi.fn();
const freebusy = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: class {} },
    calendar: () => ({
      events: { insert, delete: vi.fn() },
      freebusy: { query: freebusy },
    }),
  },
}));

const { GoogleCalendarProvider } = await import('./google-calendar.provider.js');

function provider(overrides: { calendarId?: string; serviceAccountEmail?: string } = {}) {
  return new GoogleCalendarProvider({
    calendarId: overrides.calendarId ?? 'tenant-a@group.calendar.google.com',
    serviceAccountEmail: overrides.serviceAccountEmail ?? 'svc-a@proj.iam.gserviceaccount.com',
    privateKey: 'key',
    slotMinutes: 30,
    workStart: '06:00',
    workEnd: '15:00',
  });
}

/** Google's real 403 shape for a service account without Domain-Wide Delegation. */
const FORBIDDEN = Object.assign(new Error('Service accounts cannot invite attendees'), {
  code: 403,
  errors: [{ reason: 'forbiddenForServiceAccounts' }],
});

const booking = {
  start: '2026-08-20T09:00:00.000Z',
  serviceId: '',
  attendee: { name: 'Lead', email: 'lead@example.com', timezone: 'Asia/Jerusalem' },
};

function okEvent() {
  return { data: { id: 'evt-1', status: 'confirmed', start: {}, end: {} } };
}

beforeEach(() => {
  GoogleCalendarProvider._resetCredentialCaches();
  insert.mockReset();
  freebusy.mockReset();
});

describe('attendee-invite block is per credential scope', () => {
  it('one tenant\'s 403 does not stop another tenant inviting attendees', async () => {
    const a = provider({ calendarId: 'a@group.calendar.google.com' });
    const b = provider({ calendarId: 'b@group.calendar.google.com' });

    // Tenant A's service account cannot invite attendees: first insert 403s, retry without them.
    insert.mockRejectedValueOnce(FORBIDDEN).mockResolvedValueOnce(okEvent());
    const resultA = await a.createBooking(booking);
    expect(resultA.inviteSent).toBe(false);

    // Tenant B is a different calendar and must still be TRIED with attendees.
    insert.mockResolvedValueOnce(okEvent());
    const resultB = await b.createBooking(booking);
    expect(resultB.inviteSent).toBe(true);
    expect(insert.mock.calls.at(-1)?.[0].requestBody.attendees).toBeDefined();
  });

  it('still caches within one scope, so the 403 is paid once and not per booking', async () => {
    const a = provider();

    insert.mockRejectedValueOnce(FORBIDDEN).mockResolvedValueOnce(okEvent());
    await a.createBooking(booking);
    expect(insert).toHaveBeenCalledTimes(2); // attempt + fallback

    insert.mockResolvedValueOnce(okEvent());
    const second = await a.createBooking(booking);
    // One call, straight to the attendee-less form — the optimisation the static was there for.
    expect(insert).toHaveBeenCalledTimes(3);
    expect(second.inviteSent).toBe(false);
    expect(insert.mock.calls.at(-1)?.[0].requestBody.attendees).toBeUndefined();
  });

  it('a second instance on the SAME credentials shares the cache', async () => {
    // Providers are constructed per call, so the cache must survive instances or it caches nothing.
    insert.mockRejectedValueOnce(FORBIDDEN).mockResolvedValueOnce(okEvent());
    await provider().createBooking(booking);

    insert.mockResolvedValueOnce(okEvent());
    const again = await provider().createBooking(booking);
    expect(again.inviteSent).toBe(false);
  });
});

describe('circuit breaker is per credential scope', () => {
  it('one tenant\'s broken calendar does not open the breaker for another', async () => {
    const a = provider({ calendarId: 'a@group.calendar.google.com' });
    const b = provider({ calendarId: 'b@group.calendar.google.com' });

    // Five failures is the threshold: tenant A's calendar is now considered down.
    freebusy.mockRejectedValue(new Error('invalid_grant'));
    for (let i = 0; i < 5; i++) {
      await a
        .getAvailableSlots({ startDate: '2026-08-20', endDate: '2026-08-20', serviceId: '', timezone: 'Asia/Jerusalem' })
        .catch(() => undefined);
    }

    // Tenant B's calendar is fine and must still be reachable. With the shared breaker this call
    // never left the process at all.
    freebusy.mockResolvedValueOnce({ data: { calendars: { 'b@group.calendar.google.com': { busy: [] } } } });
    const slots = await b.getAvailableSlots({
      startDate: '2026-08-20',
      endDate: '2026-08-20',
      serviceId: '',
      timezone: 'Asia/Jerusalem',
    });
    expect(slots.length).toBeGreaterThan(0);
  });
});
