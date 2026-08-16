import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GoogleCalendarConnectionService,
  buildConsentUrl,
  type GoogleOAuthConfig,
} from './google-calendar.connection.js';
import { ValidationError, AppError } from '../../../shared/errors.js';

/**
 * Per-tenant Google Calendar connection.
 *
 * The customer clicks Connect, consents in their own Google account, and lands back here. From
 * then on their agent books into THEIR calendar instead of ClickScales'.
 *
 * ── The `state` parameter is a security control, not a breadcrumb ─────────────────────────────
 *
 * `/callback` is reached by a browser redirect from Google, so it CANNOT be behind the normal API
 * auth — there is no Authorization header on a top-level navigation. The tenant id therefore has
 * to travel through Google and come back, and if it came back as a plain value anyone could hand
 * us `?state=<someone-else's-tenant>&code=<their own>` and attach their Google account to another
 * customer's workspace — or, worse, attach a calendar they control to a tenant whose meetings they
 * would then see.
 *
 * So `state` is `tenantId.timestamp.hmac`, signed with the app secret and domain-separated from
 * every other signed value in this codebase (`src/modules/webhooks/webhook-tokens.ts` does the
 * same for webhook URLs). It is verified in constant time and expires, because a consent link
 * sitting in a browser history for a month is a link somebody else may follow.
 */

const STATE_DOMAIN = 'gcal-oauth-state:v1';
/** Long enough for a slow consent (2FA, account chooser, "which of my 4 accounts?"), short enough
 * that a stale link in history is useless. */
const STATE_TTL_MS = 30 * 60 * 1000;

export function signState(secret: string, tenantId: string, issuedAt: number): string {
  const payload = `${tenantId}.${issuedAt}`;
  const mac = createHmac('sha256', secret).update(`${STATE_DOMAIN}:${payload}`).digest('hex').slice(0, 32);
  return `${payload}.${mac}`;
}

export function verifyState(secret: string, state: string, now = Date.now()): string | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, issuedAtRaw, mac] = parts as [string, string, string];

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return null;
  if (now - issuedAt > STATE_TTL_MS || issuedAt - now > 60_000) return null;

  const expected = signState(secret, tenantId, issuedAt).split('.')[2]!;
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return tenantId;
}

const calendarIdSchema = z.object({ calendarId: z.string().trim().min(1).max(255) });

/** Renders a tiny page that closes the popup / points the customer back. No framework, no CSP fight. */
function resultPage(ok: boolean, message: string): string {
  const colour = ok ? '#4f46e5' : '#b91c1c';
  return `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Connection failed'}</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7fb;color:#0c1226">
<div style="text-align:center;max-width:32rem;padding:2rem">
<h1 style="font-size:1.25rem;color:${colour};margin:0 0 .5rem">${ok ? 'Calendar connected' : 'Could not connect'}</h1>
<p style="font-size:.9rem;line-height:1.6;color:#4b5168;margin:0">${message}</p>
<p style="font-size:.8rem;color:#8a90a6;margin-top:1.5rem">You can close this window.</p>
</div>
<script>try{window.opener&&window.opener.postMessage({source:'clickscales',type:'gcal',ok:${ok}},'*')}catch(e){}</script>`;
}

/**
 * Mounted OUTSIDE the authenticated API scope for `/callback` only — see the note above. Everything
 * else here is tenant-authenticated normally.
 */
export async function googleCalendarPublicRoutes(app: FastifyInstance) {
  const service = new GoogleCalendarConnectionService(app.db, app.env.ENCRYPTION_KEY);

  app.get('/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };

    if (query.error) {
      // The customer pressed Cancel, or Google refused. Not our error to log loudly.
      return reply.type('text/html').send(resultPage(false, `Google reported: ${query.error}`));
    }
    if (!query.code || !query.state) {
      return reply.type('text/html').send(resultPage(false, 'The link was incomplete. Start again from Integrations.'));
    }

    const tenantId = verifyState(app.env.JWT_SECRET, query.state);
    if (!tenantId) {
      request.log.warn({ audit: true, event: 'gcal_oauth_bad_state' }, 'rejected google callback');
      return reply
        .type('text/html')
        .send(resultPage(false, 'This link is invalid or has expired. Start again from Integrations.'));
    }

    const config = oauthConfig(app);
    try {
      const { accountEmail } = await service.completeConnection(config, tenantId, query.code);
      request.log.info({ audit: true, event: 'gcal_connected', tenantId }, 'google calendar connected');
      return reply
        .type('text/html')
        .send(
          resultPage(
            true,
            accountEmail
              ? `Bookings will now go into ${accountEmail}'s calendar.`
              : 'Bookings will now go into the calendar you just authorised.',
          ),
        );
    } catch (err) {
      request.log.error({ err, tenantId }, 'gcal_connect_failed');
      return reply
        .type('text/html')
        .send(resultPage(false, err instanceof Error ? err.message : 'Unexpected error.'));
    }
  });
}

function oauthConfig(app: FastifyInstance): GoogleOAuthConfig {
  const clientId = app.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
  const clientSecret = app.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
  const redirectUri = app.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    // 503, not 500: nothing is broken, the feature is simply not configured on this deployment.
    throw new AppError(
      'Google Calendar connection is not configured on this server',
      503,
      'GOOGLE_OAUTH_NOT_CONFIGURED',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export async function googleCalendarRoutes(app: FastifyInstance) {
  const service = new GoogleCalendarConnectionService(app.db, app.env.ENCRYPTION_KEY);

  app.get('/status', async (request) => {
    const tenantId = (request as any).tenantId as string;
    const status = await service.status(tenantId);
    return {
      ...status,
      // Tells the dashboard whether to offer Connect at all, so a customer is not sent to a button
      // that 503s.
      available: Boolean(
        app.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID &&
          app.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET &&
          app.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI,
      ),
      /** True for ClickScales' own tenant, which uses the service account instead of OAuth. */
      usesPlatformCredentials: app.env.PLATFORM_TENANT_ID === tenantId,
    };
  });

  app.post('/connect', async (request) => {
    const tenantId = (request as any).tenantId as string;
    const config = oauthConfig(app);
    const state = signState(app.env.JWT_SECRET, tenantId, Date.now());
    return { url: buildConsentUrl(config, state) };
  });

  app.put('/calendar', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    const parsed = calendarIdSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('A calendar id is required');

    const existing = await service.status(tenantId);
    if (!existing.connected) throw new ValidationError('Connect a Google account first');

    await service.setCalendarId(tenantId, parsed.data.calendarId);
    return reply.status(200).send({ ok: true, calendarId: parsed.data.calendarId });
  });

  app.delete('/', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    await service.disconnect(tenantId);
    request.log.info({ audit: true, event: 'gcal_disconnected', tenantId }, 'google calendar disconnected');
    return reply.status(200).send({ ok: true });
  });
}
