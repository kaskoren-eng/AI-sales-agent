import type { FastifyInstance } from 'fastify';
import { TenantService } from './tenant.service.js';
import { createTenantSchema, updateTenantSchema, updateFlowSchema } from './tenant.schemas.js';
import { ValidationError } from '../../shared/errors.js';

export async function tenantRoutes(app: FastifyInstance) {
  const service = new TenantService(app.db);

  // Create tenant
  app.post('/', async (request, reply) => {
    const result = createTenantSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    const tenant = await service.create(result.data);
    reply.status(201).send(tenant);
  });

  // List tenants
  app.get('/', async () => {
    return service.list();
  });

  // Get current tenant (from auth context)
  app.get('/me', async (request) => {
    return service.getById(request.tenantId);
  });

  // Regenerate API key for current tenant
  app.post('/me/api-key', async (request) => {
    return service.rotateApiKey(request.tenantId);
  });

  // Get tenant by ID
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return service.getById(id);
  });

  // Update tenant
  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const result = updateTenantSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    return service.update(id, result.data);
  });

  // Rotate API key — returns new plaintext key once
  app.post('/:id/rotate-key', async (request) => {
    const { id } = request.params as { id: string };
    return service.rotateApiKey(id);
  });

  // Get tenant flows
  app.get('/:id/flows', async (request) => {
    const { id } = request.params as { id: string };
    return service.getFlows(id);
  });

  // Update a specific flow
  app.put('/:id/flows', async (request) => {
    const { id } = request.params as { id: string };
    const result = updateFlowSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    const tenant = await service.updateFlow(id, result.data.flowName, result.data.flow);
    return { ok: true, flows: ((tenant.settings as any)?.flows) ?? {} };
  });
}
