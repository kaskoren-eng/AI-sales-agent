import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { leads, tenants } from '../../db/schema/index.js';
import { flowDefinitionSchema } from '../flows/flow.schemas.js';
import { enqueueFlowStep } from '../../queues/flow-executor.queue.js';
import { verifyMetaSignature, normalizeMetaLeadPayload } from './meta.utils.js';
import { isTimestampFresh } from '../../shared/webhook-timestamp.js';

/**
 * Generic lead intake webhook.
 *
 * Sources:
 * - Meta Lead Ads  (x-lead-source: meta)  — verified via x-hub-signature-256 + META_APP_SECRET
 *                                            tenant resolved from ?tenant_id query param
 * - Generic / website (default)           — verified via x-webhook-secret header
 *                                            tenant resolved from LEAD_WEBHOOK_TENANT_ID env var
 *                                            (never from the request body — prevents spoofing)
 */

// Generic payload — no tenant_id field; tenant is server-side only
const genericLeadSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  source: z.string().default('webhook'),
  metadata: z.record(z.unknown()).optional(),
}).refine(d => d.phone || d.email, {
  message: 'At least one of phone or email is required',
});

export async function leadIntakeRoutes(app: FastifyInstance) {
  // Meta webhook verification challenge (GET)
  app.get('/', async (request, reply) => {
    const query = request.query as Record<string, string>;
    if (
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] === app.env.LEAD_WEBHOOK_SECRET
    ) {
      return reply.send(query['hub.challenge']);
    }
    return reply.status(403).send({ error: 'Verification failed' });
  });

  // Lead intake (POST)
  app.post('/', async (request, reply) => {
    // Auto-detect Meta: they always send x-hub-signature-256; fallback to explicit header or generic
    const source = request.headers['x-hub-signature-256']
      ? 'meta'
      : ((request.headers['x-lead-source'] as string) ?? 'generic');

    // 1. Verify signature + resolve tenantId — source-specific
    let tenantId: string;
    let rawLead: Record<string, any>;

    if (source === 'meta') {
      const appSecret = app.env.META_APP_SECRET;
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      if (!appSecret || !signature) {
        return reply.status(401).send({ error: 'Missing Meta signature or app secret' });
      }
      if (!verifyMetaSignature(JSON.stringify(request.body), signature, appSecret)) {
        app.log.warn('Lead intake: Meta signature verification failed');
        return reply.status(401).send({ error: 'Invalid signature' });
      }
      const qTenantId = (request.query as Record<string, string>).tenant_id;
      if (!qTenantId) {
        return reply.status(400).send({ error: 'tenant_id query param required for Meta webhooks' });
      }
      tenantId = qTenantId;
      rawLead = normalizeMetaLeadPayload(request.body as Record<string, any>, tenantId);
    } else {
      // Generic / website: verify shared secret header
      const secret = request.headers['x-webhook-secret'] as string | undefined;
      const expected = app.env.LEAD_WEBHOOK_SECRET;
      if (expected && secret !== expected) {
        app.log.warn('Lead intake: invalid webhook secret');
        return reply.status(401).send({ error: 'Invalid webhook secret' });
      }

      // Replay attack protection
      const ts = request.headers['x-timestamp'] as string | undefined;
      if (ts && !isTimestampFresh(Number(ts))) {
        app.log.warn({ ts }, 'Lead intake: stale timestamp — possible replay attack');
        return reply.status(401).send({ error: 'Stale request' });
      }
      // Tenant comes from server config, not the request body
      const envTenantId = app.env.LEAD_WEBHOOK_TENANT_ID;
      if (!envTenantId) {
        app.log.error('Lead intake: LEAD_WEBHOOK_TENANT_ID not configured');
        return reply.status(503).send({ error: 'Webhook intake not configured' });
      }
      tenantId = envTenantId;
      rawLead = request.body as Record<string, any>;
    }

    // 2. Validate lead fields
    const parsed = genericLeadSchema.safeParse(rawLead);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.flatten() }, 'Lead intake: invalid payload');
      return reply.status(400).send({
        error: 'Invalid payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { name, email, phone, source: leadSource, metadata } = parsed.data;

    // 3. Verify tenant exists
    const [tenant] = await app.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    // 4. Upsert lead — deduplicate by phone then email
    let lead: any;
    if (phone) {
      const [existing] = await app.db
        .select()
        .from(leads)
        .where(and(eq(leads.tenantId, tenantId), eq(leads.phone, phone)))
        .limit(1);
      lead = existing;
    }
    if (!lead && email) {
      const [existing] = await app.db
        .select()
        .from(leads)
        .where(and(eq(leads.tenantId, tenantId), eq(leads.email, email)))
        .limit(1);
      lead = existing;
    }

    if (!lead) {
      const [created] = await app.db
        .insert(leads)
        .values({
          tenantId,
          name,
          email,
          phone,
          source: leadSource,
          status: 'new',
          metadata: metadata ?? {},
        })
        .returning();
      lead = created;
    }

    // 5. Kick off the lead-intake flow if tenant has one configured
    const settings = tenant.settings as Record<string, any> | null;
    const rawFlow = settings?.flows?.['lead-intake'];
    if (rawFlow) {
      const flowParsed = flowDefinitionSchema.safeParse(rawFlow);
      if (flowParsed.success && flowParsed.data.enabled && flowParsed.data.steps.length > 0) {
        const firstStep = flowParsed.data.steps[0];
        await enqueueFlowStep(
          app.queues.flowExecutor,
          {
            tenantId,
            leadId: lead.id,
            flowName: 'lead-intake',
            stepIndex: 0,
            leadPhone: phone ?? '',
            leadName: name,
            leadEmail: email,
          },
          firstStep.delayMinutes * 60_000,
        );
        app.log.info({ leadId: lead.id, tenantId }, 'Lead intake: flow enqueued');
      }
    }

    app.log.info({ leadId: lead.id, tenantId, source: leadSource }, 'Lead intake: processed');
    return reply.status(200).send({ ok: true, leadId: lead.id });
  });
}
