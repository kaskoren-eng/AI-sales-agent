import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AirtableService } from './airtable.service.js';
import { encrypt, decrypt } from '../../../shared/crypto.js';
import { getTenantId } from '../../../shared/tenant-context.js';
import { tenants } from '../../../db/schema/index.js';

const configureSchema = z.object({
  apiKey: z.string().min(1),
  baseId: z.string().min(1),
  tableId: z.string().min(1),
  phoneFieldName: z.string().optional(),
  emailFieldName: z.string().optional(),
});

export async function airtableRoutes(app: FastifyInstance) {
  // POST /integrations/airtable/configure
  app.post('/configure', async (request, reply) => {
    const tenantId = getTenantId(request);
    const body = configureSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid payload', details: body.error.flatten().fieldErrors });
    }

    const { apiKey, baseId, tableId, phoneFieldName, emailFieldName } = body.data;

    const svc = new AirtableService({ apiKey, baseId, tableId });
    try {
      await svc.listTables();
    } catch {
      return reply.status(401).send({ error: 'Airtable API key is invalid or lacks permission' });
    }

    const encryptedApiKey = encrypt(apiKey, app.env.ENCRYPTION_KEY);

    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const existing = (tenant?.settings as Record<string, any>) ?? {};
    await app.db
      .update(tenants)
      .set({
        settings: { ...existing, airtable: { encryptedApiKey, baseId, tableId, phoneFieldName, emailFieldName } },
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    app.log.info({ tenantId, baseId, tableId }, 'Airtable configured');
    return reply.send({ ok: true, baseId, tableId });
  });

  // DELETE /integrations/airtable/configure
  app.delete('/configure', async (request, reply) => {
    const tenantId = getTenantId(request);
    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const existing = (tenant?.settings as Record<string, any>) ?? {};
    const { airtable: _removed, ...rest } = existing;
    await app.db.update(tenants).set({ settings: rest, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
    return reply.send({ ok: true });
  });

  // GET /integrations/airtable/status
  app.get('/status', async (request, reply) => {
    const tenantId = getTenantId(request);
    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const airtable = (tenant?.settings as Record<string, any> | null)?.airtable;
    if (!airtable) return reply.send({ connected: false });

    return reply.send({
      connected: true,
      baseId: airtable.baseId,
      tableId: airtable.tableId,
      phoneFieldName: airtable.phoneFieldName ?? null,
      emailFieldName: airtable.emailFieldName ?? null,
    });
  });

  // GET /integrations/airtable/tables — list tables for the configured base (for UI)
  app.get('/tables', async (request, reply) => {
    const tenantId = getTenantId(request);
    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const airtable = (tenant?.settings as Record<string, any> | null)?.airtable;
    if (!airtable?.encryptedApiKey) {
      return reply.status(404).send({ error: 'Airtable not configured' });
    }

    const apiKey = decrypt(airtable.encryptedApiKey, app.env.ENCRYPTION_KEY);
    const svc = new AirtableService({ apiKey, baseId: airtable.baseId, tableId: airtable.tableId });
    const tables = await svc.listTables();
    return reply.send({ tables });
  });
}
