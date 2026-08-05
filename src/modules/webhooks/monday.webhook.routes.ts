import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { leads, tenants } from '../../db/schema/index.js';
import { verifyWebhookToken } from './webhook-tokens.js';

/**
 * Monday.com webhook handler.
 *
 * WHAT THIS USED TO DO, and why the shape changed:
 *
 * The handler took `boardId` from the request BODY, selected every row in `tenants`, and looped
 * looking for one whose `settings.monday.boardId` matched. The caller therefore chose the tenant.
 * Signature verification was conditional on `MONDAY_WEBHOOK_SECRET` being set — and it was not set
 * in production — so an unauthenticated POST with a guessed board id and item id could change lead
 * statuses inside a live customer's account. It then loaded that tenant's ENTIRE leads table into
 * memory to find one row by a metadata field, and issued `UPDATE leads WHERE id = ...` with no
 * tenant predicate.
 *
 * Now: the tenant comes from a signed URL (see webhook-tokens.ts), the lead is fetched by an
 * indexed query scoped to that tenant, and the update carries the tenant predicate. Monday's own
 * body signature is still verified when configured, as a second, independent check.
 */

/** Monday status labels we accept, mapped to our lead statuses. */
const STATUS_MAP: Record<string, string> = {
  new: 'new',
  contacted: 'contacted',
  qualifying: 'qualifying',
  qualified: 'qualified',
  disqualified: 'disqualified',
};

export async function mondayWebhookRoutes(app: FastifyInstance) {
  /**
   * The URL-signing key. `ENCRYPTION_KEY` is already required at boot and already the root of the
   * tenant-secret hierarchy, so reusing it costs no new configuration — which matters, because a
   * webhook URL that only works once someone remembers to set a new variable is a webhook URL that
   * silently does nothing. Domain-separated inside webhook-tokens.ts so a signature minted here
   * cannot verify anywhere else.
   */
  const urlSecret = app.env.ENCRYPTION_KEY;

  /**
   * The legacy unsigned route. It cannot be made safe — its whole design is "the body says which
   * tenant" — so it is refused rather than repaired.
   *
   * 410 and not 404: this endpoint existed and is gone, and an operator staring at a failing
   * integration needs to be told that, plus where the new URL comes from. Silently accepting and
   * ignoring would be worse than either — CRM status changes would stop syncing with nothing to
   * show for it.
   */
  app.post('/', async (request, reply) => {
    // The challenge handshake still has to work, or re-pointing the webhook in Monday's UI fails
    // before the operator ever sees the error below.
    const body = request.body as Record<string, any> | undefined;
    if (body?.challenge) return reply.send({ challenge: body.challenge });

    request.log.warn(
      { audit: true, event: 'monday_webhook_legacy_url' },
      'a Monday webhook arrived on the retired unsigned URL and was refused',
    );
    return reply.status(410).send({
      error: 'This webhook URL has been retired',
      detail:
        'Monday webhooks now use a per-tenant signed URL. Run `node scripts/webhook-url.mjs <tenant-slug>` and update the webhook in Monday.',
    });
  });

  app.post('/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = request.body as Record<string, any> | undefined;

    // Answer the challenge BEFORE authenticating: Monday sends it to verify the endpoint exists,
    // and echoing a caller-supplied nonce discloses nothing.
    if (body?.challenge) return reply.send({ challenge: body.challenge });

    const tenantId = verifyWebhookToken(urlSecret, 'monday', token);
    if (!tenantId) {
      request.log.warn(
        { audit: true, event: 'monday_webhook_bad_token', ip: request.ip },
        'Monday webhook rejected: URL signature did not verify',
      );
      // 404, not 401: an unsigned URL is not a resource. Distinguishing "wrong signature" from
      // "no such tenant" would let a prober confirm tenant ids.
      return reply.status(404).send({ error: 'Not found' });
    }

    // Monday's own body signature, when configured — an independent check on the MESSAGE, where
    // the URL authenticates the ROUTE. Still optional, because it is per-webhook configuration in
    // Monday's UI, but it is no longer the only thing standing between the internet and a write.
    const secret = app.env.MONDAY_WEBHOOK_SECRET;
    if (secret) {
      const signature = request.headers['authorization'] as string | undefined;
      if (!signature) return reply.status(401).send({ error: 'Missing Authorization header' });

      const rawBody = (request as any).rawBody ?? JSON.stringify(body);
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      try {
        if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
          request.log.warn({ audit: true, event: 'monday_webhook_bad_signature', tenantId }, 'invalid body signature');
          return reply.status(401).send({ error: 'Invalid signature' });
        }
      } catch {
        return reply.status(401).send({ error: 'Invalid signature format' });
      }
    }

    const event = body?.event;
    if (!event) return reply.send({ ok: true });

    const { itemId, columnId, value } = event;
    if (!itemId) return reply.send({ ok: true });

    try {
      await handleMondayEvent(app, tenantId, String(itemId), columnId, value);
    } catch (err) {
      request.log.error({ err, tenantId }, 'Monday webhook: event handling failed');
      // Still 200: Monday retries on non-2xx, and retrying a non-transient error just repeats it.
    }

    return reply.send({ ok: true });
  });
}

async function handleMondayEvent(
  app: FastifyInstance,
  tenantId: string,
  mondayItemId: string,
  columnId: string | undefined,
  value: unknown,
) {
  /**
   * One indexed row, not the whole table.
   *
   * This previously selected every lead belonging to the tenant and searched the result in
   * JavaScript for a matching `metadata.mondayItemId`. At ClickScales' current size that is
   * invisible; at ten thousand leads it is a full table scan into Node's heap on every webhook,
   * and Monday will happily send a burst of them. The partial index added in migration 0009 makes
   * this a lookup.
   */
  const [lead] = await app.db
    .select({ id: leads.id, status: leads.status })
    .from(leads)
    .where(
      and(
        eq(leads.tenantId, tenantId),
        sql`${leads.metadata}->>'mondayItemId' = ${mondayItemId}`,
      ),
    )
    .limit(1);

  if (!lead) {
    // Normal: an item created in Monday that we have never seen. Not an error.
    app.log.debug({ mondayItemId, tenantId }, 'Monday webhook: no matching lead');
    return;
  }

  const [tenantRow] = await app.db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const columnMap = (tenantRow?.settings as Record<string, any> | null)?.monday?.columnMap ?? {};

  const updates: Record<string, unknown> = {};
  if (columnId && columnId === columnMap.status && value) {
    const label = (value as any)?.label?.text ?? (value as any)?.label ?? String(value);
    const normalized = String(label).toLowerCase().replace(/\s+/g, '_');
    if (STATUS_MAP[normalized]) updates.status = STATUS_MAP[normalized];
  }

  if (Object.keys(updates).length === 0) return;

  updates.updatedAt = new Date();

  // The tenant predicate is redundant given the SELECT above scoped by tenant — and it stays,
  // because it costs nothing and it is the line that has to be there when someone later changes
  // how `lead` is obtained.
  await app.db
    .update(leads)
    .set(updates as any)
    .where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));

  app.log.info(
    { audit: true, event: 'monday_webhook_lead_updated', leadId: lead.id, tenantId, updates },
    'Monday webhook: lead updated',
  );
}
