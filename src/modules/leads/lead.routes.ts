import type { FastifyInstance } from 'fastify';
import { LeadService } from './lead.service.js';
import { createLeadSchema, updateLeadSchema } from './lead.schemas.js';
import { getTenantId } from '../../shared/tenant-context.js';
import { enqueueFlowStep } from '../../queues/flow-executor.queue.js';
import { eq, and } from 'drizzle-orm';
import { leads, tenants } from '../../db/schema/index.js';
import { flowDefinitionSchema } from '../flows/flow.schemas.js';

export async function leadRoutes(app: FastifyInstance) {
  const service = new LeadService(app.db);

  app.post('/', async (request, reply) => {
    const tenantId = getTenantId(request);
    const input = createLeadSchema.parse(request.body);
    const lead = await service.create(tenantId, input);
    reply.status(201).send(lead);
  });

  app.get('/', async (request) => {
    const tenantId = getTenantId(request);
    return service.list(tenantId);
  });

  app.get('/:id', async (request) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    return service.getById(tenantId, id);
  });

  app.patch('/:id', async (request) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const input = updateLeadSchema.parse(request.body);
    return service.update(tenantId, id, input);
  });

  // POST /:id/trigger-flow — manually kick off a named flow for a lead
  app.post('/:id/trigger-flow', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const { flowName = 'lead-intake' } = (request.body as any) ?? {};

    const [lead] = await app.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)))
      .limit(1);

    if (!lead) return reply.status(404).send({ error: 'Lead not found' });

    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const rawFlow = (tenant?.settings as Record<string, any>)?.flows?.[flowName];
    if (!rawFlow) return reply.status(404).send({ error: `Flow "${flowName}" not configured for this tenant` });

    const parsed = flowDefinitionSchema.safeParse(rawFlow);
    if (!parsed.success || !parsed.data.enabled || !parsed.data.steps.length) {
      return reply.status(400).send({ error: `Flow "${flowName}" is disabled or has no steps` });
    }

    const firstStep = parsed.data.steps[0];
    await enqueueFlowStep(
      app.queues.flowExecutor,
      {
        tenantId,
        leadId: lead.id,
        flowName,
        stepIndex: 0,
        leadPhone: lead.phone ?? '',
        leadName: lead.name ?? undefined,
        leadEmail: lead.email ?? undefined,
      },
      firstStep.delayMinutes * 60_000,
    );

    app.log.info({ tenantId, leadId: lead.id, flowName }, 'Flow manually triggered');
    return reply.send({ ok: true, leadId: lead.id, flowName, steps: parsed.data.steps.length });
  });
}
