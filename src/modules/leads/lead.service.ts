import { eq, and, ilike, or, count, inArray, desc } from 'drizzle-orm';
import { leads, conversations, messages, scheduledCalls } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import type { CreateLeadInput, UpdateLeadInput } from './lead.schemas.js';
import { NotFoundError } from '../../shared/errors.js';
import { meterLead } from '../billing/usage.service.js';

export class LeadService {
  constructor(private db: Database) {}

  async create(tenantId: string, input: CreateLeadInput) {
    const [lead] = await this.db
      .insert(leads)
      .values({ tenantId, ...input })
      .returning();
    // BILLABLE. Idempotent on the lead id, so a retried request that somehow reaches here twice
    // counts once. Never throws — see meterLead.
    if (lead) await meterLead(this.db, { tenantId, leadId: lead.id, source: lead.source });
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

  /**
   * Returns a lead plus the entire activity around it — all channels of conversation, all
   * messages within those conversations, and every scheduled call. The Lead Detail dashboard
   * page consumes this in one shot instead of hitting four endpoints.
   *
   * Tenant isolation is enforced everywhere: the lead lookup is scoped, then every follow-up
   * query filters by tenantId as a defense-in-depth belt-and-braces.
   */
  async getByIdWithTimeline(tenantId: string, id: string) {
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)))
      .limit(1);

    if (!lead) throw new NotFoundError('Lead', id);

    // Conversations for this lead — every channel (voice, whatsapp, email)
    const convos = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.leadId, id)))
      .orderBy(desc(conversations.createdAt));

    // Messages across all those conversations, chronological ascending for timeline rendering
    const convoIds = convos.map((c) => c.id);
    const msgs = convoIds.length
      ? await this.db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.tenantId, tenantId),
              inArray(messages.conversationId, convoIds),
            ),
          )
          .orderBy(messages.createdAt)
      : [];

    // Every scheduled/booked meeting tied to this lead
    const bookings = await this.db
      .select()
      .from(scheduledCalls)
      .where(and(eq(scheduledCalls.tenantId, tenantId), eq(scheduledCalls.leadId, id)))
      .orderBy(desc(scheduledCalls.scheduledAt));

    return { lead, conversations: convos, messages: msgs, scheduledCalls: bookings };
  }
}
