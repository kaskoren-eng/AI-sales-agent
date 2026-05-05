import fp from 'fastify-plugin';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { MonitorCallService } from './monitor-call.service.js';

const createMonitorCallSchema = z.object({
  user_phone: z.string().min(7),
  client_phone: z.string().min(7),
  label: z.string().max(255).optional(),
});

const updateOutcomeSchema = z.object({
  outcome: z.enum(['won', 'lost', 'neutral']),
});

const learningIdParamSchema = z.object({
  id: z.string().uuid(),
});

async function monitorCallRoutes(app: FastifyInstance) {
  const service = new MonitorCallService(app.db, app.redis, app.env);

  // POST /monitor — create a monitored conference call
  app.post('/monitor', async (request, reply) => {
    const parsed = createMonitorCallSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { user_phone, client_phone, label } = parsed.data;
    const tenantId = request.tenantId;

    const result = await service.createMonitoredCall({
      tenantId,
      userPhone: user_phone,
      clientPhone: client_phone,
      label,
    });

    return reply.status(201).send(result);
  });

  // PATCH /monitor/:id/outcome — manually label a monitored call outcome
  app.patch('/monitor/:id/outcome', async (request, reply) => {
    const params = learningIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const body = updateOutcomeSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(422).send({
        error: 'VALIDATION_ERROR',
        details: body.error.flatten().fieldErrors,
      });
    }

    const { callLearnings } = await import('../../db/schema/call-learnings.js');
    const { eq, and } = await import('drizzle-orm');

    const [updated] = await app.db
      .update(callLearnings)
      .set({ outcome: body.data.outcome })
      .where(and(eq(callLearnings.id, params.data.id), eq(callLearnings.tenantId, request.tenantId)))
      .returning({ id: callLearnings.id, outcome: callLearnings.outcome });

    if (!updated) return reply.status(404).send({ error: 'Learning record not found' });

    return reply.status(200).send(updated);
  });

  // GET /monitor/learnings — list call learnings for tenant
  app.get('/monitor/learnings', async (request, reply) => {
    const { callLearnings } = await import('../../db/schema/call-learnings.js');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await app.db
      .select({
        id: callLearnings.id,
        label: callLearnings.label,
        outcome: callLearnings.outcome,
        status: callLearnings.status,
        durationSecs: callLearnings.durationSecs,
        analysis: callLearnings.analysis,
        createdAt: callLearnings.createdAt,
      })
      .from(callLearnings)
      .where(eq(callLearnings.tenantId, request.tenantId))
      .orderBy(desc(callLearnings.createdAt))
      .limit(50);

    return reply.status(200).send({ data: rows });
  });
}

export default fp(monitorCallRoutes);
