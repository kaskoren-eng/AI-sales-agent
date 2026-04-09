import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tenants } from '../../db/schema/index.js';
import { TenantService } from './tenant.service.js';
import { createTenantSchema, updateTenantSchema, updateFlowSchema } from './tenant.schemas.js';

export async function tenantRoutes(app: FastifyInstance) {
  const service = new TenantService(app.db);

  // Create tenant
  app.post('/', async (request, reply) => {
    const input = createTenantSchema.parse(request.body);
    const tenant = await service.create(input);
    reply.status(201).send(tenant);
  });

  // List tenants
  app.get('/', async () => {
    return service.list();
  });

  // Get tenant by ID
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return service.getById(id);
  });

  // Update tenant
  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = updateTenantSchema.parse(request.body);
    return service.update(id, input);
  });

  // Get tenant flows
  app.get('/:id/flows', async (request) => {
    const { id } = request.params as { id: string };
    return service.getFlows(id);
  });

  // Update a specific flow
  app.put('/:id/flows', async (request) => {
    const { id } = request.params as { id: string };
    const { flowName, flow } = updateFlowSchema.parse(request.body);
    const tenant = await service.updateFlow(id, flowName, flow);
    return { ok: true, flows: ((tenant.settings as any)?.flows) ?? {} };
  });
}
