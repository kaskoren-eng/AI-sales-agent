import type { FastifyInstance } from 'fastify';
import { LeadService } from './lead.service.js';
import { createLeadSchema, updateLeadSchema } from './lead.schemas.js';
import { getTenantId } from '../../shared/tenant-context.js';
import { enqueueFlowStep } from '../../queues/flow-executor.queue.js';
import { eq, and } from 'drizzle-orm';
import { leads, tenants } from '../../db/schema/index.js';
import { flowDefinitionSchema } from '../flows/flow.schemas.js';
import { recordAudit, actorFromRequest } from '../../shared/audit.js';
import { cancelMeetingReminders } from '../../queues/meeting-reminders.queue.js';

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
    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query['page'] ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query['limit'] ?? '20', 10) || 20));
    const { data, total } = await service.list(tenantId, { page, limit, status: query['status'], search: query['search'] });
    return { data, meta: { page, limit, total, total_pages: Math.ceil(total / limit) } };
  });

  app.get('/:id', async (request) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    return service.getById(tenantId, id);
  });

  // GET /:id/timeline — lead + conversations + messages + scheduled calls (for Lead Detail page)
  app.get('/:id/timeline', async (request) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    return service.getByIdWithTimeline(tenantId, id);
  });

  app.patch('/:id', async (request) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const input = updateLeadSchema.parse(request.body);
    return service.update(tenantId, id, input);
  });

  /**
   * DELETE /:id — erase a lead and everything written about them.
   *
   * `docs/legal-drafts/privacy-policy` promises deletion on request. Nothing implemented it, which
   * meant the only honest answer to "please delete my data" was a manual SQL statement — and the
   * only record of it having happened was that someone remembered doing it.
   *
   * Three deliberate boundaries, all visible in the response rather than buried:
   *
   *   1. THE USAGE LEDGER SURVIVES. `usage_events` keeps a row keyed on the lead id, and it stays.
   *      It holds a count and an id, never a name, a phone or a transcript — so it is not personal
   *      data — and erasing it would let anyone delete their way out of an invoice. Deletion must
   *      not be a billing operation.
   *   2. CALENDAR EVENTS ARE NOT CANCELLED. Deleting a database row must not silently cancel a
   *      real meeting in the customer's diary; that is destructive, outward-facing, and not what
   *      "delete this lead" asks for. The event ids are returned so the operator can act on them
   *      knowingly. (If the deletion is a privacy erasure, they DO need cancelling — hence
   *      surfacing them instead of staying quiet.)
   *   3. REMINDERS ARE CANCELLED. Those are ours and internal, and a reminder firing about a
   *      deleted lead would be both a bug and a privacy leak — it would send their name onward
   *      after erasure.
   */
  app.delete('/:id', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };

    const summary = await service.delete(tenantId, id);

    // Best-effort, and AFTER the rows are gone: a queue hiccup must not leave the lead undeleted.
    // The reminder worker re-checks its scheduled_calls row at fire time and finds nothing, so a
    // missed cancellation degrades to a no-op rather than to a message about a deleted person.
    if (summary.reminderJobIds.length > 0 && app.queues?.meetingReminders) {
      await cancelMeetingReminders(app.queues.meetingReminders, summary.reminderJobIds).catch(() => 0);
    }

    // The audit row carries the blast radius and the lead's NAME, captured before deletion —
    // "lead.deleted 3f2a…" answers nothing six months later when the row it points at is gone.
    // It deliberately carries no phone, email or transcript: an audit trail that accumulates the
    // very data that was erased is a new copy of it.
    await recordAudit(app.db, {
      tenantId,
      ...actorFromRequest(request),
      action: 'lead.deleted',
      targetType: 'lead',
      targetId: id,
      metadata: {
        name: summary.name ?? null,
        conversations: summary.conversations,
        messages: summary.messages,
        scheduledCalls: summary.scheduledCalls,
        remindersCancelled: summary.reminderJobIds.length,
        calendarEventsLeftInPlace: summary.calendarEventRefs.length,
      },
    });

    return reply.send({
      deleted: true,
      leadId: id,
      conversations: summary.conversations,
      messages: summary.messages,
      scheduledCalls: summary.scheduledCalls,
      // Named so the caller cannot mistake it for "we cancelled these".
      calendarEventsNotCancelled: summary.calendarEventRefs,
    });
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
