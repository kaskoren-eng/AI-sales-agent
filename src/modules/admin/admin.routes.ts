import type { FastifyInstance } from 'fastify';
import { AdminService } from './admin.service.js';
import { TenantService } from '../tenants/tenant.service.js';
import { createTenantSchema, updateTenantSchema } from '../tenants/tenant.schemas.js';
import { requireAdmin } from './admin.guard.js';
import { ValidationError } from '../../shared/errors.js';
import { invalidateTenantStatus } from '../../plugins/tenant-status.js';
import { safeTenant } from '../tenants/settings-policy.js';

export async function adminRoutes(app: FastifyInstance) {
  const admin = new AdminService(app.db);
  const tenantsSvc = new TenantService(app.db);

  // Every admin route requires the operator key.
  app.addHook('onRequest', requireAdmin(app));

  // --- Monitoring ---
  app.get('/overview', async () => admin.overview());
  app.get('/tenants', async () => ({ data: await admin.listTenants() }));
  app.get('/tenants/:id', async (request) => {
    const { id } = request.params as { id: string };
    return admin.tenantDetail(id);
  });

  // --- Management (cross-tenant — this is the ONLY place these live) ---
  app.post('/tenants', async (request, reply) => {
    const result = createTenantSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    // Returns the plaintext apiKey ONCE — the operator copies it now; only the hash is stored.
    const created = await tenantsSvc.create(result.data);
    reply.status(201).send(created);
  });

  app.patch('/tenants/:id', async (request) => {
    const { id } = request.params as { id: string };
    const result = updateTenantSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    // name / slug / isActive — isActive:false is "suspend", true is "activate".
    const updated = await tenantsSvc.update(id, result.data);

    // Suspension is enforced from a 30s-TTL status cache (see plugins/tenant-status.ts), so
    // without this the operator clicks "suspend" and the tenant keeps working for up to half a
    // minute — long enough to look broken, and long enough to place another call. Best-effort:
    // if Redis is unreachable the entry expires on its own.
    if (result.data.isActive !== undefined) {
      await invalidateTenantStatus(app.redis, id);
      request.log.info({
        audit: true,
        event: result.data.isActive ? 'tenant_activated' : 'tenant_suspended',
        tenantId: id,
      });
    }

    return safeTenant(updated);
  });

  app.post('/tenants/:id/rotate-key', async (request) => {
    const { id } = request.params as { id: string };
    // Returns the new plaintext key once.
    return tenantsSvc.rotateApiKey(id);
  });
}
