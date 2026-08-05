import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import { TenantService } from './tenant.service.js';
import { flowDefinitionSchema } from '../flows/flow.schemas.js';
import {
  updateSelfSchema,
  updateFlowSchema,
  updateSettingsNamespaceSchema,
} from './tenant.schemas.js';
import {
  isTenantWritable,
  describeRefusal,
  redactSettings,
  safeTenant,
} from './settings-policy.js';
import { ValidationError, ForbiddenError } from '../../shared/errors.js';

/**
 * A settings section is small by nature: field maps, offsets, a business description. The cap is
 * generous for all of those and still stops `tenants.settings` — which the voice agent reads while
 * a caller is on the line — from being used as a document store.
 */
const MAX_NAMESPACE_BYTES = 64 * 1024;

/**
 * Per-section schemas, applied on top of the allowlist.
 *
 * Only sections that already have a schema appear here — this is not a place to invent validation,
 * it is a place to make sure the generic write path enforces the same rules the typed route does.
 * `flows` is the one that matters today: `PUT /me/flows` validates against `flowDefinitionSchema`,
 * and without this entry a tenant could write a malformed flow through the generic route and only
 * find out when the flow-executor worker hit it.
 */
const NAMESPACE_VALIDATORS: Record<string, ZodType> = {
  flows: z.record(z.string(), flowDefinitionSchema),
};

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

  /**
   * Write ONE section of the settings document.
   *
   * The section name is checked against an allowlist that is closed by default, so an unclassified
   * namespace is refused rather than written. Operator-controlled sections — spend caps, voice
   * engine, enabled tools — and every credential-bearing section are refused here by name, with a
   * message that says where they are actually managed.
   */
  app.patch('/me/settings/:namespace', async (request) => {
    const { namespace } = request.params as { namespace: string };

    if (!isTenantWritable(namespace)) {
      // 403, not 404: the section exists, the caller may not write it. Pretending it does not
      // exist would send an operator hunting for a typo.
      request.log.warn(
        { audit: true, event: 'settings_write_refused', tenantId: request.tenantId, namespace },
        'refused a write to a settings section this tenant does not control',
      );
      throw new ForbiddenError(describeRefusal(namespace));
    }

    const result = updateSettingsNamespaceSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError('Send the section contents as a JSON object');

    if (JSON.stringify(result.data).length > MAX_NAMESPACE_BYTES) {
      throw new ValidationError(`That settings section is too large (max ${MAX_NAMESPACE_BYTES / 1024}KB)`);
    }

    // Where a section has a real schema, it is enforced here too. Otherwise this generic route
    // becomes the way around the typed one, and malformed config is accepted silently at write
    // time to fail later inside a worker — or mid-call.
    const validator = NAMESPACE_VALIDATORS[namespace];
    if (validator) {
      const typed = validator.safeParse(result.data);
      if (!typed.success) {
        throw new ValidationError(
          `${namespace}: ${typed.error.issues[0]?.path.join('.')} ${typed.error.issues[0]?.message}`,
        );
      }
    }

    const tenant = await service.updateSettingsNamespace(request.tenantId, namespace, result.data);
    return { ok: true, namespace, settings: redactSettings(tenant.settings) };
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
