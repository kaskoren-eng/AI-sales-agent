import { eq, and, ilike, or, count } from 'drizzle-orm';
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

  async list(tenantId: string, opts: { page: number; limit: number; status?: string; search?: string } = { page: 1, limit: 20 }) {
    const { page, limit, status, search } = opts;
    const offset = (page - 1) * limit;

    const conditions = [eq(leads.tenantId, tenantId)];
    if (status) conditions.push(eq(leads.status, status as any));
    if (search) conditions.push(or(ilike(leads.name, `%${search}%`), ilike(leads.phone, `%${search}%`), ilike(leads.email, `%${search}%`))!);

    const where = and(...conditions);

    const [{ value: total }] = await this.db.select({ value: count() }).from(leads).where(where);
    const data = await this.db.select().from(leads).where(where).orderBy(leads.createdAt).limit(limit).offset(offset);

    return { data, total };
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
