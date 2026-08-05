import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { MondayService, type MondayColumnMap } from './monday.service.js';
import { encrypt, decrypt } from '../../../shared/crypto.js';
import { getTenantId } from '../../../shared/tenant-context.js';
import { tenants, leads } from '../../../db/schema/index.js';

const configureSchema = z.object({
  apiToken: z.string().min(1),
  boardId: z.string().min(1),
  columnMap: z.object({
    email: z.string().optional(),
    phone: z.string().optional(),
    status: z.string().optional(),
    score: z.string().optional(),
  }).default({}),
});

const pushLeadSchema = z.object({
  leadId: z.string().uuid(),
});

/** Retrieve and decrypt the stored Monday config for a tenant, or throw. */
async function getMondayService(app: FastifyInstance, tenantId: string): Promise<MondayService> {
  const [tenant] = await app.db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const monday = (tenant?.settings as Record<string, any> | null)?.monday;
  if (!monday?.encryptedApiToken) {
    throw Object.assign(new Error('Monday.com not configured for this tenant'), { statusCode: 404 });
  }

  const apiToken = decrypt(monday.encryptedApiToken, app.env.ENCRYPTION_KEY);
  return new MondayService({
    apiToken,
    boardId: monday.boardId,
    columnMap: monday.columnMap ?? {},
  });
}

export async function mondayRoutes(app: FastifyInstance) {
  // POST /integrations/monday/configure — save API token + board + column mapping
  app.post('/configure', async (request, reply) => {
    const tenantId = getTenantId(request);
    const body = configureSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid payload', details: body.error.flatten().fieldErrors });
    }

    const { apiToken, boardId, columnMap } = body.data;

    // Validate token works before saving
    const svc = new MondayService({ apiToken, boardId, columnMap });
    try {
      await svc.getBoards();
    } catch {
      return reply.status(401).send({ error: 'Monday API token is invalid or lacks permission' });
    }

    const encryptedApiToken = encrypt(apiToken, app.env.ENCRYPTION_KEY);

    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const existingSettings = (tenant?.settings as Record<string, any>) ?? {};
    await app.db
      .update(tenants)
      .set({
        settings: { ...existingSettings, monday: { encryptedApiToken, boardId, columnMap } },
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    app.log.info({ tenantId, boardId }, 'Monday.com configured');
    return reply.send({ ok: true, boardId });
  });

  // DELETE /integrations/monday/configure — remove Monday config
  app.delete('/configure', async (request, reply) => {
    const tenantId = getTenantId(request);
    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const existing = (tenant?.settings as Record<string, any>) ?? {};
    const { monday: _removed, ...rest } = existing;
    await app.db.update(tenants).set({ settings: rest, updatedAt: new Date() }).where(eq(tenants.id, tenantId));

    return reply.send({ ok: true });
  });

  // GET /integrations/monday/status — return config (without token)
  app.get('/status', async (request, reply) => {
    const tenantId = getTenantId(request);
    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const monday = (tenant?.settings as Record<string, any> | null)?.monday;
    if (!monday) return reply.send({ connected: false });

    return reply.send({
      connected: true,
      boardId: monday.boardId,
      columnMap: monday.columnMap ?? {},
    });
  });

  // GET /integrations/monday/boards — list boards for the connected account
  app.get('/boards', async (request, reply) => {
    const tenantId = getTenantId(request);
    const svc = await getMondayService(app, tenantId).catch(() => null);
    if (!svc) return reply.status(404).send({ error: 'Monday.com not configured' });

    const boards = await svc.getBoards();
    return reply.send({ boards });
  });

  // GET /integrations/monday/boards/:boardId/columns — list columns (helps UI build the column map)
  app.get('/boards/:boardId/columns', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { boardId } = request.params as { boardId: string };
    const svc = await getMondayService(app, tenantId).catch(() => null);
    if (!svc) return reply.status(404).send({ error: 'Monday.com not configured' });

    const columns = await svc.getBoardColumns(boardId);
    return reply.send({ columns });
  });

  // POST /integrations/monday/sync — pull items from Monday board, upsert as leads
  // Body: { groupId?: string }
  app.post('/sync', async (request, reply) => {
    const tenantId = getTenantId(request);
    const svc = await getMondayService(app, tenantId);

    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const boardId = (tenant?.settings as Record<string, any>)?.monday?.boardId;
    const groupId = (request.body as any)?.groupId as string | undefined;
    const items = await svc.getItems(boardId, groupId);

    let created = 0;
    let skipped = 0;

    for (const item of items) {
      const parsed = svc.parseLeadFromItem(item);

      // Skip items with no contact info
      if (!parsed.email && !parsed.phone) { skipped++; continue; }

      // Deduplicate by phone then email
      let existing: any = null;
      if (parsed.phone) {
        const [row] = await app.db
          .select()
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), eq(leads.phone, parsed.phone)))
          .limit(1);
        existing = row;
      }
      if (!existing && parsed.email) {
        const [row] = await app.db
          .select()
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), eq(leads.email, parsed.email)))
          .limit(1);
        existing = row;
      }

      if (!existing) {
        // Normalize phone: ensure it starts with + for international format
        const phone = parsed.phone
          ? parsed.phone.startsWith('+') ? parsed.phone : `+${parsed.phone}`
          : undefined;

        await app.db.insert(leads).values({
          tenantId,
          name: parsed.name || undefined,
          email: parsed.email,
          phone,
          source: 'monday',
          status: 'new',
          externalId: parsed.mondayItemId,
          metadata: { mondayItemId: parsed.mondayItemId },
        });
        created++;
      } else {
        skipped++;
      }
    }

    app.log.info({ tenantId, boardId, created, skipped }, 'Monday sync complete');
    return reply.send({ ok: true, created, skipped, total: items.length });
  });

  // POST /integrations/monday/push — push a single lead to Monday as an item
  app.post('/push', async (request, reply) => {
    const tenantId = getTenantId(request);
    const body = pushLeadSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid payload', details: body.error.flatten().fieldErrors });
    }

    const svc = await getMondayService(app, tenantId);

    const [tenant] = await app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const boardId = (tenant?.settings as Record<string, any>)?.monday?.boardId;

    const [lead] = await app.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, body.data.leadId)))
      .limit(1);

    if (!lead) return reply.status(404).send({ error: 'Lead not found' });

    const existingItemId = (lead.metadata as Record<string, any>)?.mondayItemId;
    const colVals = svc.buildColumnValues(lead);

    if (existingItemId) {
      await svc.updateItem(boardId, existingItemId, colVals);
      return reply.send({ ok: true, mondayItemId: existingItemId, action: 'updated' });
    }

    const mondayItemId = await svc.createItem(boardId, lead.name ?? lead.email ?? 'Lead', colVals);

    // Persist Monday item ID back to lead metadata
    const existingMeta = (lead.metadata as Record<string, any>) ?? {};
    await app.db
      .update(leads)
      .set({ metadata: { ...existingMeta, mondayItemId }, updatedAt: new Date() })
      // The tenant predicate is redundant here — `lead` came from a tenant-scoped read — and it
      // stays anyway. The Monday WEBHOOK had exactly this shape and became a cross-tenant write
      // the moment the id started coming from somewhere less trustworthy.
      .where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));

    app.log.info({ tenantId, leadId: lead.id, mondayItemId }, 'Lead pushed to Monday');
    return reply.send({ ok: true, mondayItemId, action: 'created' });
  });
}
