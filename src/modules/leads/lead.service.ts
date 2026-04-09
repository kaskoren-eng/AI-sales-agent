import { eq, and } from 'drizzle-orm';
import { leads } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import type { CreateLeadInput, UpdateLeadInput } from './lead.schemas.js';
import { NotFoundError } from '../../shared/errors.js';

export class LeadService {
  constructor(private db: Database) {}

  async create(tenantId: string, input: CreateLeadInput) {
    const [lead] = await this.db
      .insert(leads)
      .values({ tenantId, ...input })
      .returning();
    return lead;
  }

  async getById(tenantId: string, id: string) {
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)))
      .limit(1);

    if (!lead) throw new NotFoundError('Lead', id);
    return lead;
  }

  async list(tenantId: string) {
    return this.db
      .select()
      .from(leads)
      .where(eq(leads.tenantId, tenantId))
      .orderBy(leads.createdAt);
  }

  async update(tenantId: string, id: string, input: UpdateLeadInput) {
    const [lead] = await this.db
      .update(leads)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)))
      .returning();

    if (!lead) throw new NotFoundError('Lead', id);
    return lead;
  }

  async findByPhone(tenantId: string, phone: string) {
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.phone, phone)))
      .limit(1);
    return lead ?? null;
  }

  async findByEmail(tenantId: string, email: string) {
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.email, email)))
      .limit(1);
    return lead ?? null;
  }
}
