import { and, eq, isNull } from 'drizzle-orm';
import { google } from 'googleapis';
import type { Database } from '../../../db/client.js';
import { oauthConnections } from '../../../db/schema/index.js';
import { encrypt, decrypt } from '../../../shared/crypto.js';
import type { GoogleCalendarAuth } from '../../scheduling/providers/google-calendar.provider.js';

/**
 * Per-tenant Google Calendar connections.
 *
 * ── The problem this closes ───────────────────────────────────────────────────────────────────
 *
 * Bookings were made with ONE set of credentials read from `GOOGLE_CALENDAR_*` env, for every
 * tenant. So customer #2's agent would qualify their lead, agree a time, and write the meeting
 * into ClickScales' calendar — where their salesperson would never see it, and where ClickScales
 * would see a stranger's meeting appear. Nothing errors; the agent even tells the lead it is
 * booked, because from the tool's point of view it is.
 *
 * The global env credentials survive as ONE TENANT'S credentials — ClickScales', identified by
 * `PLATFORM_TENANT_ID`. Every other tenant must connect their own Google account, or their agent
 * simply has no calendar tools (fail-closed, the same as every other gate here).
 */

export const GOOGLE_CALENDAR_PROVIDER = 'google_calendar';

/**
 * Scopes we ask for, and nothing more.
 *
 * `calendar.events` rather than the full `calendar` scope: we create, read and delete events. We
 * never need to create calendars or change sharing, and asking for it would show the customer a
 * scarier consent screen for capability we do not use. `userinfo.email` is only so the dashboard
 * can show WHICH account is linked — a tenant with two Google accounts will otherwise have no way
 * to tell whether they connected the right one.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function makeOAuthClient(config: GoogleOAuthConfig) {
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

/**
 * The consent URL.
 *
 * `access_type: 'offline'` + `prompt: 'consent'` are BOTH required, and the second is the one
 * people leave out. Google returns a refresh token only on the first consent for a given
 * client/user pair; on every later authorisation it returns an access token alone. Without
 * `prompt: 'consent'` a tenant who reconnects — after revoking, after switching account, after we
 * lose the row — gets a grant with no refresh token, and their calendar breaks an hour later when
 * the access token expires. Forcing the consent screen every time costs one extra click and
 * removes an entire class of "it worked yesterday".
 */
export function buildConsentUrl(config: GoogleOAuthConfig, state: string): string {
  return makeOAuthClient(config).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_CALENDAR_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export interface StoredConnection {
  tenantId: string;
  accountEmail: string | null;
  calendarId: string;
  scope: string | null;
  revokedAt: Date | null;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
}

export class GoogleCalendarConnectionService {
  constructor(
    private db: Database,
    private encryptionKey: string,
  ) {}

  /**
   * Exchange the authorisation code and store the grant.
   *
   * Upserts on (tenant, provider) so reconnecting REPLACES the grant rather than accumulating
   * rows — there is never a question of which of two connections is authoritative.
   */
  async completeConnection(
    config: GoogleOAuthConfig,
    tenantId: string,
    code: string,
  ): Promise<{ accountEmail: string | null }> {
    const client = makeOAuthClient(config);
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      // See `buildConsentUrl`: with prompt=consent this should be impossible. If it happens, the
      // honest move is to refuse rather than store a connection that dies in an hour.
      throw new Error(
        'Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and connect again.',
      );
    }

    client.setCredentials(tokens);
    let accountEmail: string | null = null;
    try {
      const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
      accountEmail = info.data.email ?? null;
    } catch {
      // Cosmetic — the dashboard shows "connected" without naming the account. Never fail the
      // connection over a label.
    }

    const now = new Date();
    const row = {
      tenantId,
      provider: GOOGLE_CALENDAR_PROVIDER,
      refreshTokenEncrypted: encrypt(tokens.refresh_token, this.encryptionKey),
      accessTokenEncrypted: tokens.access_token ? encrypt(tokens.access_token, this.encryptionKey) : null,
      accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      accountEmail,
      scope: tokens.scope ?? null,
      revokedAt: null,
      updatedAt: now,
    };

    await this.db
      .insert(oauthConnections)
      .values(row)
      .onConflictDoUpdate({
        target: [oauthConnections.tenantId, oauthConnections.provider],
        set: row,
      });

    return { accountEmail };
  }

  /** The live connection for a tenant, or null if absent or revoked. */
  async get(tenantId: string): Promise<StoredConnection | null> {
    const [row] = await this.db
      .select()
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.tenantId, tenantId),
          eq(oauthConnections.provider, GOOGLE_CALENDAR_PROVIDER),
          isNull(oauthConnections.revokedAt),
        ),
      )
      .limit(1);
    if (!row) return null;

    let refreshToken: string;
    try {
      refreshToken = decrypt(row.refreshTokenEncrypted, this.encryptionKey);
    } catch (err) {
      // Do NOT swallow this into a null "not connected" — that is how a tenant is told to
      // reconnect a calendar that is actually fine, while the real problem (a rotated
      // ENCRYPTION_KEY) goes unnoticed across every integration at once.
      console.error(
        'gcal_connection_decrypt_failed',
        JSON.stringify({ tenantId, error: err instanceof Error ? err.message : String(err) }),
      );
      throw new Error('Stored Google credentials could not be decrypted');
    }

    let accessToken: string | null = null;
    if (row.accessTokenEncrypted) {
      try {
        accessToken = decrypt(row.accessTokenEncrypted, this.encryptionKey);
      } catch {
        // Recoverable on its own: a bad access token just means refresh one.
        accessToken = null;
      }
    }

    return {
      tenantId: row.tenantId,
      accountEmail: row.accountEmail,
      calendarId: row.calendarId,
      scope: row.scope,
      revokedAt: row.revokedAt,
      refreshToken,
      accessToken,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
    };
  }

  /** Status for the dashboard. Never throws — a broken connection is a status, not a 500. */
  async status(
    tenantId: string,
  ): Promise<{ connected: boolean; accountEmail: string | null; calendarId: string | null; needsReconnect: boolean }> {
    const [row] = await this.db
      .select()
      .from(oauthConnections)
      .where(
        and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.provider, GOOGLE_CALENDAR_PROVIDER)),
      )
      .limit(1);

    if (!row) return { connected: false, accountEmail: null, calendarId: null, needsReconnect: false };
    return {
      connected: row.revokedAt === null,
      accountEmail: row.accountEmail,
      calendarId: row.calendarId,
      // A revoked row is kept on purpose: "reconnect the account you had" is a far better message
      // than "connect a calendar", and which account it WAS is the first question when a customer
      // reports bookings stopped.
      needsReconnect: row.revokedAt !== null,
    };
  }

  /** Persist a refreshed access token. Best-effort by contract — callers must not await failure. */
  async saveAccessToken(tenantId: string, accessToken: string, expiresAt: Date | null): Promise<void> {
    await this.db
      .update(oauthConnections)
      .set({
        accessTokenEncrypted: encrypt(accessToken, this.encryptionKey),
        accessTokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.provider, GOOGLE_CALENDAR_PROVIDER)),
      );
  }

  /**
   * Mark a grant dead. Called when Google says `invalid_grant` — the customer revoked us, changed
   * their password, or deleted the account.
   */
  async markRevoked(tenantId: string): Promise<void> {
    await this.db
      .update(oauthConnections)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.provider, GOOGLE_CALENDAR_PROVIDER)),
      );
  }

  /** Tenant-initiated disconnect. Deletes the row — this one IS the customer asking us to forget. */
  async disconnect(tenantId: string): Promise<void> {
    await this.db
      .delete(oauthConnections)
      .where(
        and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.provider, GOOGLE_CALENDAR_PROVIDER)),
      );
  }

  async setCalendarId(tenantId: string, calendarId: string): Promise<void> {
    await this.db
      .update(oauthConnections)
      .set({ calendarId, updatedAt: new Date() })
      .where(
        and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.provider, GOOGLE_CALENDAR_PROVIDER)),
      );
  }
}

/**
 * Turn a stored connection into the auth object the provider wants.
 *
 * `onTokensRefreshed` is wired to a fire-and-forget persist: a failed write costs the NEXT call one
 * token round-trip, and must never cost THIS call its booking.
 */
export function toProviderAuth(
  config: GoogleOAuthConfig,
  connection: StoredConnection,
  service: GoogleCalendarConnectionService,
): GoogleCalendarAuth {
  return {
    kind: 'oauth',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: connection.refreshToken,
    ...(connection.accessToken ? { accessToken: connection.accessToken } : {}),
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    ...(connection.accountEmail ? { accountEmail: connection.accountEmail } : {}),
    onTokensRefreshed: ({ accessToken, expiresAt }) => {
      void service
        .saveAccessToken(connection.tenantId, accessToken, expiresAt)
        .catch((err) =>
          console.error(
            'gcal_access_token_persist_failed',
            JSON.stringify({
              tenantId: connection.tenantId,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        );
    },
  };
}
