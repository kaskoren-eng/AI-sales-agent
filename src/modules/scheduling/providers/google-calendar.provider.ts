import { google } from 'googleapis';
import type { SchedulingProvider, TimeSlot, BookingResult } from './provider.interface.js';
import { CircuitBreaker } from '../../../shared/circuit-breaker.js';

/**
 * ONE CIRCUIT BREAKER PER CALENDAR, not one for the whole process.
 *
 * It used to be a single module-level breaker. With one customer that is correct — there is one
 * calendar, and five failures against it genuinely mean "Google is unreachable, stop trying". With
 * two customers it is a cross-tenant outage: tenant A revokes our OAuth grant, five bookings fail,
 * the breaker opens, and tenant B — whose calendar is perfectly healthy — cannot book for the next
 * thirty seconds because of a problem in someone else's Google account.
 *
 * Keyed by credential scope, so a broken calendar only breaks its own.
 */
const circuits = new Map<string, CircuitBreaker>();

function circuitFor(scope: string): CircuitBreaker {
  let breaker = circuits.get(scope);
  if (!breaker) {
    breaker = new CircuitBreaker({
      name: `google-calendar:${scope}`,
      failureThreshold: 5,
      cooldownMs: 30_000,
    });
    circuits.set(scope, breaker);
  }
  return breaker;
}

/** Matches Google's 403 "Service accounts cannot invite attendees without Domain-Wide Delegation". */
function isForbiddenForServiceAccounts(err: unknown): boolean {
  const e = err as { code?: number; errors?: Array<{ reason?: string }>; message?: string };
  return (
    e?.code === 403 &&
    ((e.errors ?? []).some((x) => x?.reason === 'forbiddenForServiceAccounts') ||
      (e.message ?? '').includes('Service accounts cannot invite attendees'))
  );
}

/**
 * HOW this provider is allowed to act on a calendar.
 *
 * `service_account` is ClickScales' own arrangement: one Google service account, one calendar,
 * optionally impersonating a Workspace user via Domain-Wide Delegation. It cannot work for a
 * customer — we would need admin rights in THEIR Google Workspace to grant delegation.
 *
 * `oauth` is what a customer can actually do: click Connect, consent once, and we hold a refresh
 * token for their account. It also invites attendees without the 403, because the events are
 * created as a real user rather than a service account.
 */
export type GoogleCalendarAuth =
  | {
      kind: 'service_account';
      serviceAccountEmail: string;
      privateKey: string;
      /** Workspace user to impersonate. Requires Domain-Wide Delegation for the client id. */
      impersonateUser?: string;
    }
  | {
      kind: 'oauth';
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      accessToken?: string;
      accessTokenExpiresAt?: Date | null;
      /** Identifies the grant for the per-scope caches; not used to authenticate. */
      accountEmail?: string;
      /**
       * Called when googleapis mints a new access token, so it can be persisted.
       *
       * WITHOUT THIS the refresh happens in memory and is thrown away when the call ends, so every
       * single call pays a token round-trip before it can read the calendar — and on the agent,
       * that latency lands between the lead saying a day and the agent answering. It must never
       * throw: a failed write is a slower next call, not a failed booking.
       */
      onTokensRefreshed?: (tokens: { accessToken: string; expiresAt: Date | null }) => void;
    };

export class GoogleCalendarProvider implements SchedulingProvider {
  /**
   * Which credential scopes have been proven unable to invite attendees.
   *
   * The 403 is a property of a SET OF CREDENTIALS — a service account without Domain-Wide
   * Delegation — not of the process. As one process-wide boolean it was a genuine cross-tenant
   * bug waiting for customer #2: the first service-account tenant to hit the 403 would
   * permanently disable attendee invites for every OAuth tenant in the same worker, silently
   * downgrading their bookings to attendee-less events with `inviteSent: false`. Their leads would
   * simply stop receiving calendar invitations, and nothing would say why.
   *
   * Cached per scope, so the optimisation still works and stays where it belongs.
   */
  private static blockedScopes = new Set<string>();

  /** Visible for tests — process-wide caches make tests order-dependent otherwise. */
  static _resetCredentialCaches(): void {
    GoogleCalendarProvider.blockedScopes.clear();
    circuits.clear();
  }

  /**
   * Identifies the CREDENTIALS this instance uses, for the per-scope caches above.
   *
   * Deliberately built from the calendar and the identity acting on it, not from a tenant id: two
   * tenants sharing one service account genuinely do share the 403, and one tenant that later
   * reconnects with different credentials genuinely deserves a fresh attempt.
   */
  private readonly scope: string;

  private calendar: ReturnType<typeof google.calendar>;

  constructor(
    private config: {
      calendarId: string;
      slotMinutes: number;
      workStart: string;
      workEnd: string;
      /**
       * How to authenticate. Omit and the legacy service-account fields below are used instead,
       * so every existing construction site keeps working unchanged.
       */
      auth?: GoogleCalendarAuth;
      /** @deprecated Pass `auth: { kind: 'service_account', ... }`. Kept so the many existing
       * call sites — bench scripts, the scheduling module, tests — did not all have to change in
       * the same commit as the OAuth work. */
      serviceAccountEmail?: string;
      /** @deprecated see `serviceAccountEmail`. */
      privateKey?: string;
      /**
       * Workspace user to impersonate (e.g. koren@clickscales.com). Requires Domain-Wide
       * Delegation granted to this service account's CLIENT ID in the Google Admin Console
       * (Security → API Controls → Domain-wide delegation, scope
       * https://www.googleapis.com/auth/calendar). This is THE fix for the attendee-invite 403:
       * with a subject, events are created AS the user, invites email out, and the auto Meet
       * link comes back. Without it (or before the grant), the attendee-less fallback below
       * keeps bookings alive.
       *
       * @deprecated see `serviceAccountEmail`.
       */
      impersonateUser?: string;
    },
  ) {
    const auth: GoogleCalendarAuth =
      config.auth ??
      ({
        kind: 'service_account',
        serviceAccountEmail: config.serviceAccountEmail!,
        privateKey: config.privateKey!,
        ...(config.impersonateUser ? { impersonateUser: config.impersonateUser } : {}),
      } as GoogleCalendarAuth);

    if (auth.kind === 'oauth') {
      const client = new google.auth.OAuth2(auth.clientId, auth.clientSecret);
      client.setCredentials({
        refresh_token: auth.refreshToken,
        ...(auth.accessToken ? { access_token: auth.accessToken } : {}),
        ...(auth.accessTokenExpiresAt ? { expiry_date: auth.accessTokenExpiresAt.getTime() } : {}),
      });
      // googleapis refreshes lazily and tells us here. Persisting it is what stops every call
      // paying a token round-trip before it can read the calendar.
      client.on('tokens', (tokens) => {
        if (!tokens.access_token || !auth.onTokensRefreshed) return;
        try {
          auth.onTokensRefreshed({
            accessToken: tokens.access_token,
            expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          });
        } catch (err) {
          // A failed write means the next call refreshes again. It must never fail this booking.
          console.error(
            'gcal_token_persist_failed',
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      this.calendar = google.calendar({ version: 'v3', auth: client });
      this.scope = `oauth|${auth.accountEmail ?? auth.clientId}|${config.calendarId}`;
    } else {
      const jwt = new google.auth.JWT({
        email: auth.serviceAccountEmail,
        key: auth.privateKey,
        scopes: ['https://www.googleapis.com/auth/calendar'],
        ...(auth.impersonateUser ? { subject: auth.impersonateUser } : {}),
      });
      this.calendar = google.calendar({ version: 'v3', auth: jwt });
      this.scope = `${auth.serviceAccountEmail}|${auth.impersonateUser ?? ''}|${config.calendarId}`;
    }
  }

  private get circuit(): CircuitBreaker {
    return circuitFor(this.scope);
  }

  private get attendeeInvitesBlocked(): boolean {
    return GoogleCalendarProvider.blockedScopes.has(this.scope);
  }

  async getAvailableSlots(params: {
    startDate: string;
    endDate: string;
    serviceId: string;
    timezone: string;
    employeeId?: string;
  }): Promise<TimeSlot[]> {
    const calendarId = params.serviceId || this.config.calendarId;
    const { slotMinutes, workStart, workEnd } = this.config;

    const timeMin = new Date(`${params.startDate}T00:00:00Z`).toISOString();
    const timeMax = new Date(`${params.endDate}T23:59:59Z`).toISOString();

    const freebusyRes = await this.circuit.execute(() =>
      this.calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          timeZone: params.timezone,
          items: [{ id: calendarId }],
        },
      }),
    );

    const busyPeriods = freebusyRes.data.calendars?.[calendarId]?.busy ?? [];

    const slots: TimeSlot[] = [];
    const startDate = new Date(`${params.startDate}T00:00:00Z`);
    const endDate = new Date(`${params.endDate}T00:00:00Z`);

    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      let slotStart = new Date(`${day}T${workStart}:00Z`);
      const dayEnd = new Date(`${day}T${workEnd}:00Z`);

      while (slotStart < dayEnd) {
        const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60_000);
        if (slotEnd > dayEnd) break;

        const isBusy = busyPeriods.some(({ start, end }) => {
          const busyStart = new Date(start!);
          const busyEnd = new Date(end!);
          return slotStart < busyEnd && slotEnd > busyStart;
        });

        if (!isBusy) {
          slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
        }

        slotStart = slotEnd;
      }
    }

    return slots;
  }

  async createBooking(params: {
    start: string;
    serviceId: string;
    attendee: { name: string; email?: string; phone?: string; timezone: string };
    employeeId?: string;
    notes?: string;
  }): Promise<BookingResult> {
    const calendarId = params.serviceId || this.config.calendarId;
    const startDt = new Date(params.start);
    const endDt = new Date(startDt.getTime() + this.config.slotMinutes * 60_000);

    const insert = (withAttendees: boolean) =>
      this.circuit.execute(() =>
        this.calendar.events.insert({
          calendarId,
          sendUpdates: 'all',
          conferenceDataVersion: 1,
          requestBody: {
            summary: `Sales Call — ${params.attendee.name}`,
            // When the attendee can't go ON the event (see below), their contact details go into
            // the description so the meeting owner can forward the invite by hand.
            description: withAttendees
              ? params.notes
              : [params.notes, '', `Attendee (invite NOT auto-sent): ${params.attendee.name}${params.attendee.email ? ` <${params.attendee.email}>` : ' (NO EMAIL — confirmed by WhatsApp)'}${params.attendee.phone ? ` ${params.attendee.phone}` : ''}`]
                  .filter((s) => s !== undefined)
                  .join('\n'),
            start: { dateTime: startDt.toISOString(), timeZone: params.attendee.timezone },
            end: { dateTime: endDt.toISOString(), timeZone: params.attendee.timezone },
            ...(withAttendees
              ? { attendees: [{ email: params.attendee.email, displayName: params.attendee.name }] }
              : {}),
            conferenceData: { createRequest: { requestId: crypto.randomUUID() } },
          },
        }),
      );

    // Service accounts CANNOT put attendees on an event without Domain-Wide Delegation — Google
    // answers 403 forbiddenForServiceAccounts (verified live 2026-07-17). The error is
    // deterministic per deployment, so after the first sighting we stop asking. The event is
    // still created (fallback below) — a booking without an emailed invite beats no booking —
    // and BookingResult.inviteSent tells the caller not to claim an email was sent.
    // THE REAL FIX is granting the service account Domain-Wide Delegation (or moving to OAuth
    // on Koren's account) — pending decision, see Phase 4 notes.
    const tryAttendees = !this.attendeeInvitesBlocked;
    let eventRes;
    let inviteSent = tryAttendees;
    try {
      eventRes = await insert(tryAttendees);
    } catch (err) {
      if (tryAttendees && isForbiddenForServiceAccounts(err)) {
        GoogleCalendarProvider.blockedScopes.add(this.scope);
        inviteSent = false;
        console.error(
          'gcal_attendee_invites_blocked — falling back to attendee-less events. Grant the service account Domain-Wide Delegation to fix.',
        );
        eventRes = await insert(false);
      } else {
        throw err;
      }
    }

    const event = eventRes.data;
    const meetLink = (event.conferenceData?.entryPoints ?? []).find(
      (ep: any) => ep.entryPointType === 'video',
    )?.uri as string | undefined;
    return {
      uid: event.id!,
      start: event.start?.dateTime ?? params.start,
      end: event.end?.dateTime ?? endDt.toISOString(),
      status: event.status ?? 'confirmed',
      meetLink,
      inviteSent,
    };
  }

  async cancelBooking(bookingUid: string): Promise<void> {
    await this.circuit.execute(() =>
      this.calendar.events.delete({
        calendarId: this.config.calendarId,
        eventId: bookingUid,
        sendUpdates: 'all',
      }),
    );
  }
}
