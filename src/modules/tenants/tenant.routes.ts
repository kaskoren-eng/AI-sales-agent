import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TenantService } from './tenant.service.js';
import { createTenantSchema, updateSelfSchema, updateFlowSchema } from './tenant.schemas.js';
import { ValidationError, ForbiddenError } from '../../shared/errors.js';

/** Strip the api key hash before a tenant row leaves the API. */
function safeTenant<T extends { apiKeyHash?: string | null }>(t: T) {
  const { apiKeyHash, ...rest } = t;
  return { ...rest, hasApiKey: !!apiKeyHash };
}

/**
 * Per-tenant routes. These run under tenant auth (`request.tenantId` is the CALLER).
 *
 * Cross-tenant powers (list all, create, act on an arbitrary id) live in the operator console
 * (`/api/v1/admin/*`, super-admin only) — NOT here. Everything here is scoped to the caller's own
 * tenant, so one tenant can never read or mutate another. `/me` is the canonical self path; the
 * legacy `/:id` routes are kept but hard-guarded to `id === request.tenantId`.
 */
export async function tenantRoutes(app: FastifyInstance) {
  const service = new TenantService(app.db);

  const assertSelf = (request: FastifyRequest, id: string) => {
    if (id !== request.tenantId) {
      throw new ForbiddenError('You can only access your own tenant');
    }
  };

  // Create is admin-only — blocked here so a tenant key can't mint tenants. Use POST /api/v1/admin/tenants.
  app.post('/', async () => {
    throw new ForbiddenError('Tenant creation is restricted to the operator console');
  });

  // "List" returns only the caller (no cross-tenant enumeration).
  app.get('/', async (request) => {
    return [safeTenant(await service.getById(request.tenantId))];
  });

  // --- Self (canonical) ---
  app.get('/me', async (request) => safeTenant(await service.getById(request.tenantId)));

  app.patch('/me', async (request) => {
    const result = updateSelfSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    return safeTenant(await service.update(request.tenantId, result.data));
  });

  app.post('/me/api-key', async (request) => service.rotateApiKey(request.tenantId));

  app.get('/me/flows', async (request) => service.getFlows(request.tenantId));

  app.put('/me/flows', async (request) => {
    const result = updateFlowSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    const tenant = await service.updateFlow(request.tenantId, result.data.flowName, result.data.flow);
    return { ok: true, flows: (tenant.settings as any)?.flows ?? {} };
  });

  // --- Legacy /:id (self-guarded — kept for back-compat) ---
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    assertSelf(request, id);
    return safeTenant(await service.getById(id));
  });

  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    assertSelf(request, id);
    // Self edits go through the restricted schema — no self-suspend, no slug change.
    const result = updateSelfSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    return safeTenant(await service.update(id, result.data));
  });

  app.post('/:id/rotate-key', async (request) => {
    const { id } = request.params as { id: string };
    assertSelf(request, id);
    return service.rotateApiKey(id);
  });

  app.get('/:id/flows', async (request) => {
    const { id } = request.params as { id: string };
    assertSelf(request, id);
    return service.getFlows(id);
  });

  app.put('/:id/flows', async (request) => {
    const { id } = request.params as { id: string };
    assertSelf(request, id);
    const result = updateFlowSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    const tenant = await service.updateFlow(id, result.data.flowName, result.data.flow);
    return { ok: true, flows: (tenant.settings as any)?.flows ?? {} };
  });
}
