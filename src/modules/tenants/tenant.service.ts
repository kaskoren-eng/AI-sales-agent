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

    const [tenant] = await this.db
      .insert(tenants)
      .values({ name: input.name, slug: input.slug })
      .returning();

    return tenant;
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

    const [tenant] = await this.db
      .update(tenants)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning();

    if (!tenant) throw new NotFoundError('Tenant', id);
    return tenant;
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
