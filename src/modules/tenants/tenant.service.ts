import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tenants } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import type { CreateTenantInput, UpdateTenantInput } from './tenant.schemas.js';
import { NotFoundError, ConflictError } from '../../shared/errors.js';
import type { FlowDefinition } from '../flows/flow.schemas.js';

export class TenantService {
  constructor(private db: Database) {}

  async create(input: CreateTenantInput) {
    // Check slug uniqueness
    const [existing] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, input.slug))
      .limit(1);

    if (existing) throw new ConflictError(`Slug "${input.slug}" is already taken`);

    // Generate a random API key — return the raw key once, store only the hash
    const apiKey = `sk_${randomBytes(32).toString('hex')}`;
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

    const [tenant] = await this.db
      .insert(tenants)
      .values({ name: input.name, slug: input.slug, apiKeyHash })
      .returning();

    return { ...tenant, apiKey };
  }

  async list() {
    return this.db.select().from(tenants).orderBy(tenants.createdAt);
  }

  async getById(id: string) {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', id);
    return tenant;
  }

  async update(id: string, input: UpdateTenantInput) {
    if (input.slug) {
      const [existing] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, input.slug))
        .limit(1);

      if (existing && existing.id !== id) {
        throw new ConflictError(`Slug "${input.slug}" is already taken`);
      }
    }

    /**
     * Settings MERGE at the namespace level; they do not replace the column.
     *
     * `.set({ settings })` on a jsonb column overwrites the whole document, so an operator sending
     * `{settings: {voice_engine: 'livekit'}}` — a one-key edit, and the obvious thing to send —
     * silently destroyed that tenant's stored Monday token, Zadarma credentials and spend caps.
     * The write looked like a PATCH and behaved like a PUT.
     *
     * An explicit `null` still deletes a namespace, so removal is possible but has to be asked for.
     */
    const patch: Record<string, unknown> = { ...input, updatedAt: new Date() };
    if (input.settings !== undefined) {
      patch.settings = await this.mergeSettings(id, input.settings);
    }

    const [tenant] = await this.db
      .update(tenants)
      .set(patch)
      .where(eq(tenants.id, id))
      .returning();

    if (!tenant) throw new NotFoundError('Tenant', id);
    return tenant;
  }

  /** Read-modify-write of the settings document, one namespace at a time. */
  private async mergeSettings(id: string, incoming: Record<string, unknown>) {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', id);

    const merged = { ...((tenant.settings as Record<string, unknown>) ?? {}) };
    for (const [namespace, value] of Object.entries(incoming)) {
      if (value === null) delete merged[namespace];
      else merged[namespace] = value;
    }
    return merged;
  }

  /**
   * Replace ONE namespace of the settings document. The tenant-facing write path.
   *
   * Whole-namespace replacement rather than a deep merge: a deep merge makes it impossible to
   * remove a key (sending the object without it leaves the old value behind), which is exactly the
   * bug you hit the first time someone tries to clear a field they set by mistake. Callers send
   * the section as they want it to end up.
   */
  async updateSettingsNamespace(id: string, namespace: string, value: Record<string, unknown>) {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', id);

    const settings = { ...((tenant.settings as Record<string, unknown>) ?? {}) };
    settings[namespace] = value;

    const [updated] = await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning();

    return updated;
  }

  async updateFlow(id: string, flowName: string, flow: FlowDefinition) {
    // Load current settings
    const [tenant] = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', id);

    const settings = (tenant.settings as Record<string, any>) ?? {};
    const flows = settings.flows ?? {};
    flows[flowName] = flow;
    settings.flows = flows;

    const [updated] = await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning();

    return updated;
  }

  async rotateApiKey(id: string) {
    const apiKey = `sk_${randomBytes(32).toString('hex')}`;
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

    const [tenant] = await this.db
      .update(tenants)
      .set({ apiKeyHash, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning({ id: tenants.id, name: tenants.name });

    if (!tenant) throw new NotFoundError('Tenant', id);
    return { ...tenant, apiKey };
  }

  async getFlows(id: string) {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', id);
    const settings = (tenant.settings as Record<string, any>) ?? {};
    return settings.flows ?? {};
  }
}
