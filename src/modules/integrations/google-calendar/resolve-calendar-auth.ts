import type { Env } from '../../../config/env.js';
import type { Database } from '../../../db/client.js';
import type { GoogleCalendarAuth } from '../../scheduling/providers/google-calendar.provider.js';
import { GoogleCalendarConnectionService, toProviderAuth } from './google-calendar.connection.js';

/**
 * WHOSE CALENDAR does a tenant book into.
 *
 * This used to live in the voice agent's `tool-context.ts`, which meant the answer was correct on
 * exactly one of the two paths that book meetings. The REST scheduling routes built their provider
 * straight from `GOOGLE_CALENDAR_*` env and wrote every tenant's booking into ClickScales' diary
 * while stamping the row with the customer's `tenant_id` — the database claiming one thing and the
 * calendar showing another. Moving the resolver here, next to the connection it reads, is what
 * makes "whose calendar" a single answer instead of a per-caller opinion.
 *
 * Two arrangements, and the important thing is that there is no default:
 *
 *   - PLATFORM_TENANT_ID (ClickScales) uses the `GOOGLE_CALENDAR_*` service account. Those env
 *     vars are ONE TENANT'S credentials — they only ever were — and are treated as such.
 *   - Every other tenant must have connected their own Google account. No connection means no
 *     calendar, which is the same fail-closed rule the agent's tool gates use.
 *
 * There is deliberately NO fallback from "tenant has not connected" to the platform credentials.
 * That fallback is precisely the bug: it makes a missing connection look like a working one, right
 * up until a customer asks why their meetings are in somebody else's diary.
 */
export interface ResolvedCalendar {
  calendarId: string;
  auth: GoogleCalendarAuth;
  /** For logs: which arrangement served this booking. */
  source: 'platform_service_account' | 'tenant_oauth';
}

/** How long a connection lookup may hold up a caller. A hung DB must not eat a phone greeting. */
export const CALENDAR_LOOKUP_TIMEOUT_MS = 2_000;

export type LoadCalendarConnection = (
  db: Database,
  tenantId: string,
) => Promise<{ calendarId: string; auth: GoogleCalendarAuth } | null>;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveCalendarAuth(
  env: Env,
  tenantId: string,
  db: Database,
  deps: { loadCalendarConnection?: LoadCalendarConnection } = {},
): Promise<ResolvedCalendar | null> {
  const isPlatformTenant = env.PLATFORM_TENANT_ID === tenantId;

  // A tenant's own connection always wins — including for ClickScales, if it ever connects one.
  const loadConnection =
    deps.loadCalendarConnection ??
    (async (database: Database, id: string) => {
      const service = new GoogleCalendarConnectionService(database, env.ENCRYPTION_KEY);
      const connection = await service.get(id);
      if (!connection) return null;
      const clientId = env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
      const clientSecret = env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
      const redirectUri = env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI;
      if (!clientId || !clientSecret || !redirectUri) return null;
      return {
        calendarId: connection.calendarId,
        auth: toProviderAuth({ clientId, clientSecret, redirectUri }, connection, service),
      };
    });

  try {
    const connected = await withTimeout(loadConnection(db, tenantId), CALENDAR_LOOKUP_TIMEOUT_MS);
    if (connected) return { ...connected, source: 'tenant_oauth' };
  } catch (err) {
    // A slow or broken lookup must not hang the caller. Falling through means this booking has no
    // calendar, which is recoverable and visible; hanging is neither.
    console.error(
      'gcal_connection_lookup_failed',
      JSON.stringify({ tenantId, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  if (
    isPlatformTenant &&
    env.GOOGLE_CALENDAR_ID &&
    env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL &&
    env.GOOGLE_CALENDAR_PRIVATE_KEY
  ) {
    return {
      calendarId: env.GOOGLE_CALENDAR_ID,
      source: 'platform_service_account',
      auth: {
        kind: 'service_account',
        serviceAccountEmail: env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL,
        // Stored with literal \n in env; the JWT client needs real newlines.
        privateKey: env.GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n'),
        ...(env.GOOGLE_CALENDAR_IMPERSONATE_USER
          ? { impersonateUser: env.GOOGLE_CALENDAR_IMPERSONATE_USER }
          : {}),
      },
    };
  }

  console.warn(
    'gcal_no_calendar_for_tenant',
    JSON.stringify({
      tenantId,
      isPlatformTenant,
      hint: isPlatformTenant
        ? 'PLATFORM_TENANT_ID matches but GOOGLE_CALENDAR_* env is incomplete'
        : 'tenant has not connected a Google account — booking is disabled for this tenant',
    }),
  );
  return null;
}
