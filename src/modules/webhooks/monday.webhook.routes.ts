import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { MondayService } from '../integrations/monday/monday.service.js';
import { decrypt } from '../../shared/crypto.js';
import { tenants, leads } from '../../db/schema/index.js';

/**
 * Monday.com webhook handler.
 *
 * Monday sends all webhooks as POST with JSON body.
 * On first setup it sends a challenge; you must echo it back.
 * Subsequent events have an `event` object.
 *
 * Verification: Monday signs requests with HMAC-SHA256 using the webhook's
 * signing secret. The signature is in the `Authorization` header as a hex digest.
 * If MONDAY_WEBHOOK_SECRET is configured we verify it; otherwise we skip (dev only).
 */
export async function mondayWebhookRoutes(app: FastifyInstance) {
  app.post('/', async (request, reply) => {
    const body = request.body as Record<string, any>;

    // 1. Challenge handshake (Monday sends this when you first subscribe)
    if (body?.challenge) {
      return reply.send({ challenge: body.challenge });
    }

    // 2. Signature verification
    const secret = app.env.MONDAY_WEBHOOK_SECRET;
    if (secret) {
      const signature = request.headers['authorization'] as string | undefined;
      if (!signature) {
        return reply.status(401).send({ error: 'Missing Authorization header' });
      }
      const rawBody = (request as any).rawBody ?? JSON.stringify(body);
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      try {
        if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
          app.log.warn('Monday webhook: invalid signature');
          return reply.status(401).send({ error: 'Invalid signature' });
        }
      } catch {
        return reply.status(401).send({ error: 'Invalid signature format' });
      }
    }

    // 3. Process event
    const event = body?.event;
    if (!event) return reply.send({ ok: true });

    const { boardId, itemId, columnId, value } = event;
    if (!boardId || !itemId) return reply.send({ ok: true });

    try {
      await handleMondayEvent(app, String(boardId), String(itemId), columnId, value);
    } catch (err) {
      app.log.error({ err, event }, 'Monday webhook: event handling failed');
      // Still return 200 to prevent Monday from retrying a non-transient error
    }

    return reply.send({ ok: true });
  });
}

async function handleMondayEvent(
  app: FastifyInstance,
  boardId: string,
  mondayItemId: string,
  columnId: string | undefined,
  value: unknown,
) {
  // Find which tenant owns this board
  const allTenants = await app.db.select({ id: tenants.id, settings: tenants.settings }).from(tenants);

  for (const tenant of allTenants) {
    const mondayCfg = (tenant.settings as Record<string, any> | null)?.monday;
    if (!mondayCfg || mondayCfg.boardId !== boardId) continue;

    // Found the right tenant — find the lead by mondayItemId stored in metadata
    const allLeads = await app.db
      .select()
      .from(leads)
      .where(eq(leads.tenantId, tenant.id));

    const lead = allLeads.find(
      (l) => (l.metadata as Record<string, any>)?.mondayItemId === mondayItemId,
    );

    if (!lead) {
      // Item not yet in our DB — could be a new item created in Monday; skip for now
      app.log.debug({ mondayItemId, boardId, tenantId: tenant.id }, 'Monday webhook: item not found in leads');
      return;
    }

    // Map the changed column back to a lead field
    const columnMap = mondayCfg.columnMap ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (columnId === columnMap.status && value) {
      const label = (value as any)?.label?.text ?? (value as any)?.label ?? String(value);
      // Map Monday status labels → our lead status where possible
      const STATUS_MAP: Record<string, string> = {
        new: 'new',
        contacted: 'contacted',
        qualifying: 'qualifying',
        qualified: 'qualified',
        disqualified: 'disqualified',
      };
      const normalized = label.toLowerCase().replace(/\s+/g, '_');
      if (STATUS_MAP[normalized]) updates.status = STATUS_MAP[normalized];
    }

    if (Object.keys(updates).length > 1) {
      await app.db.update(leads).set(updates as any).where(eq(leads.id, lead.id));
      app.log.info({ leadId: lead.id, tenantId: tenant.id, updates }, 'Monday webhook: lead updated');
    }

    break;
  }
}
