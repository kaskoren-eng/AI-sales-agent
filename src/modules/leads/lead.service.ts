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

  /**
   * ERASE A LEAD AND EVERYTHING WRITTEN ABOUT THEM.
   *
   * `docs/legal-drafts/` promises deletion on request, and until now nothing anywhere implemented
   * it — a policy commitment with no code behind it is the kind of gap that turns a routine
   * subject-access request into an incident.
   *
   * ── Why this is hand-rolled rather than ON DELETE CASCADE ──
   * None of the child FKs cascade, so a bare `DELETE FROM leads` fails on a foreign key and the
   * lead survives. Adding cascades to the schema would be tidier but far more dangerous: cascade
   * is invisible at the call site, and it would mean any future code path that deletes a lead
   * silently destroys its conversations too. Deletion this consequential should be spelled out.
   *
   * Every statement is tenant-scoped, including the ones that look redundant after the ownership
   * check. The check proves the lead is theirs; the predicates make it impossible for a bug in the
   * check to delete somebody else's messages.
   *
   * Returns what was destroyed, so the caller can audit it and the operator can see the blast
   * radius after the fact — the rows themselves are gone by then.
   */
  async delete(tenantId: string, id: string): Promise<LeadDeletionSummary> {
    // Ownership first, and by SELECT rather than by trusting the DELETE's predicate: a missing
    // lead must 404, not report a successful deletion of nothing.
    const lead = await this.getById(tenantId, id);

    const convos = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.leadId, id)));
    const conversationIds = convos.map((c) => c.id);

    // Read the bookings BEFORE deleting them — their reminder job ids are the only record of what
    // is queued in Redis, and once the row is gone those jobs would fire against a deleted lead.
    const bookings = await this.db
      .select({ id: scheduledCalls.id, reminders: scheduledCalls.reminders, providerRef: scheduledCalls.providerRef })
      .from(scheduledCalls)
      .where(and(eq(scheduledCalls.tenantId, tenantId), eq(scheduledCalls.leadId, id)));

    const summary: LeadDeletionSummary = {
      leadId: id,
      conversations: conversationIds.length,
      messages: 0,
      scheduledCalls: bookings.length,
      reminderJobIds: bookings.flatMap((b) => b.reminders?.jobIds ?? []),
      // Calendar events are NOT deleted here — see the route. Reported so the caller can say so.
      calendarEventRefs: bookings.map((b) => b.providerRef).filter((r): r is string => Boolean(r)),
    };

    await this.db.transaction(async (tx) => {
      // Children first, in dependency order. A partial delete would leave orphans pointing at a
      // lead that no longer exists, which is worse than not deleting at all — the data is still
      // there, but nothing can find it to try again.
      if (conversationIds.length > 0) {
        const deletedMessages = await tx
          .delete(messages)
          .where(and(eq(messages.tenantId, tenantId), inArray(messages.conversationId, conversationIds)))
          .returning({ id: messages.id });
        summary.messages = deletedMessages.length;
      }

      await tx.delete(scheduledCalls).where(and(eq(scheduledCalls.tenantId, tenantId), eq(scheduledCalls.leadId, id)));
      await tx.delete(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.leadId, id)));
      await tx.delete(leads).where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)));
    });

    return { ...summary, name: lead.name ?? null };
  }
}

export interface LeadDeletionSummary {
  leadId: string;
  /** The lead's name, captured before deletion, so the audit row still means something. */
  name?: string | null;
  conversations: number;
  messages: number;
  scheduledCalls: number;
  /** BullMQ ids that must be cancelled — the rows that referenced them are gone. */
  reminderJobIds: string[];
  /** Google Calendar event ids that still exist. Deliberately not deleted; see the route. */
  calendarEventRefs: string[];
}
