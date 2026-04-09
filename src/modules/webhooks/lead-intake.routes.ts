 import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { leads, tenants } from '../../db/schema/index.js';
import { flowDefinitionSchema } from '../flows/flow.schemas.js';
import { enqueueFlowStep } from '../../queues/flow-executor.queue.js';
import { verifyMetaSignature, normalizeMetaLeadPayload } from './meta.utils.js';

/**
 * Generic lead intake webhook.
 *
 * Accepts leads from:
 * - Meta Lead Ads (x-lead-source: meta, verified via x-hub-signature-256)
 * - Website contact forms (x-lead-source: website, verified via x-webhook-secret)
 * - Any other source (x-lead-source: generic or omitted, verified via x-webhook-secret)
 *
 * For Meta: tenant_id must be passed as a query param (?tenant_id=UUID)
 * since Meta controls the payload format.
 */
const leadIntakeSchema = z.object({
  tenant_id: z.string().uuid(),
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
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === app.env.LEAD_WEBHOOK_SECRET) {
      return reply.send(query['hub.challenge']);
    }
    reply.status(403).send({ error: 'Verification failed' });
  });

  // Lead intake (POST)
  app.post('/', async (request, reply) => {
    const source = (request.headers['x-lead-source'] as string) ?? 'generic';

    // 1. Verify signature based on source
    if (source === 'meta') {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const appSecret = app.env.META_APP_SECRET;
      if (!appSecret || !signature) {
        reply.status(401).send({ error: 'Missing Meta signature or app secret' });
        return;
      }
      const rawBody = JSON.stringify(request.body);
      if (!verifyMetaSignature(rawBody, signature, appSecret)) {
        app.log.warn('Lead intake: Meta signature verification failed');
        reply.status(401).send({ error: 'Invalid signature' });
        return;
      }
    } else {
      const secret = request.headers['x-webhook-secret'] as string | undefined;
      const expected = app.env.LEAD_WEBHOOK_SECRET;
      if (expected && secret !== expected) {
        app.log.warn('Lead intake: invalid webhook secret');
        reply.status(401).send({ error: 'Invalid webhook secret' });
        return;
      }
    }

    // 2. Normalize payload
    let normalized: Record<string, any>;
    if (source === 'meta') {
      const tenantId = (request.query as Record<string, string>).tenant_id;
      if (!tenantId) {
        reply.status(400).send({ error: 'tenant_id query param required for Meta webhooks' });
        return;
      }
      normalized = normalizeMetaLeadPayload(request.body as Record<string, any>, tenantId);
    } else {
      normalized = request.body as Record<string, any>;
    }

    // 3. Validate
    const parsed = leadIntakeSchema.safeParse(normalized);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.flatten() }, 'Lead intake: invalid payload');
      reply.status(400).send({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { tenant_id, name, email, phone, source: leadSource, metadata } = parsed.data;

    // 4. Verify tenant exists
    const [tenant] = await app.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenant_id))
      .limit(1);

    if (!tenant) {
      reply.status(404).send({ error: 'Tenant not found' });
      return;
    }

    // 5. Upsert lead (find by phone or email, create if not found)
    let lead: any;
    if (phone) {
      const [existing] = await app.db
        .select()
        .from(leads)
        .where(and(eq(leads.tenantId, tenant_id), eq(leads.phone, phone)))
        .limit(1);
      lead = existing;
    }
    if (!lead && email) {
      const [existing] = await app.db
        .select()
        .from(leads)
        .where(and(eq(leads.tenantId, tenant_id), eq(leads.email, email)))
        .limit(1);
      lead = existing;
    }

    if (!lead) {
      const [created] = await app.db
        .insert(leads)
        .values({
          tenantId: tenant_id,
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

    // 6. Kick off flow if configured
    const settings = tenant.settings as Record<string, any> | null;
    const rawFlow = settings?.flows?.['lead-intake'];
    if (rawFlow) {
      const flowParsed = flowDefinitionSchema.safeParse(rawFlow);
      if (flowParsed.success && flowParsed.data.enabled && flowParsed.data.steps.length > 0) {
        const firstStep = flowParsed.data.steps[0];
        await enqueueFlowStep(
          app.queues.flowExecutor,
          {
            tenantId: tenant_id,
            leadId: lead.id,
            flowName: 'lead-intake',
            stepIndex: 0,
            leadPhone: phone ?? '',
            leadName: name,
            leadEmail: email,
          },
          firstStep.delayMinutes * 60_000,
        );
        app.log.info({ leadId: lead.id, tenantId: tenant_id }, 'Lead intake: flow enqueued');
      }
    }

    app.log.info({ leadId: lead.id, tenantId: tenant_id, source: leadSource }, 'Lead intake: processed');
    reply.status(200).send({ ok: true, leadId: lead.id });
  });
}
