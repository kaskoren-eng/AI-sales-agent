import type { FastifyInstance } from 'fastify';
import { LeadService } from './lead.service.js';
import { createLeadSchema, updateLeadSchema } from './lead.schemas.js';
import { getTenantId } from '../../shared/tenant-context.js';

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
}
