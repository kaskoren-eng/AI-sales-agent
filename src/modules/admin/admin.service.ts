import { and, count, eq, gte, max, sum } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  tenants,
  leads,
  conversations,
  messages,
  scheduledCalls,
  callLearnings,
  plans,
  usagePeriods,
  phoneNumbers,
} from '../../db/schema/index.js';
import { NotFoundError } from '../../shared/errors.js';
import { redactSettings } from '../tenants/settings-policy.js';

/** Per-tenant rollup shown in the operator tenants table + overview. All measured, never estimated. */
export interface TenantRollup {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  hasApiKey: boolean;
  /**
   * Which plan this customer is on, and null when they are on none.
   *
   * Absent from this rollup until a tenant-onboarding rehearsal found three production workspaces
   * with `plan_code = NULL` — billing as free and unlimited — and nothing on the operator console
   * that would ever have shown it. A billing system whose console does not display the plan is a
   * billing system nobody can check.
   */
  planCode: string | null;
  billingStatus: string;
  createdAt: Date;
  leads: number;
  conversations: number;
  messages: number;
  calls: number;
  voiceMinutes: number; // sum(call_learnings.duration_secs) / 60, rounded
  meetings: number;
  lastActivityAt: string | null; // most recent message, or null
}

export interface AdminOverview {
  tenants: { total: number; active: number; suspended: number };
  totals: { leads: number; conversations: number; messages: number; calls: number; meetings: number; voiceMinutes: number };
  last24h: { leads: number; messages: number; calls: number };
}

export interface TenantDetail {
  tenant: {
    id: string; name: string; slug: string; isActive: boolean; hasApiKey: boolean; settings: unknown;
    createdAt: Date; updatedAt: Date;
    /**
     * The billing posture. An explicit projection like this one is the right shape — it is why the
     * operator console never leaked `api_key_hash` — but it also means a column added later is
     * invisible until someone adds it HERE too, and these three were exactly that: the PATCH could
     * set them and the GET could not show them, so the console rendered a blank plan for a tenant
     * that had one.
     */
    planCode: string | null; billingStatus: string; quotaEnforcement: string; billingAnchorDay: number;
  };
  stats: {
    leads: { total: number; byStatus: Record<string, number> };
    conversations: number;
    messages: { total: number; inbound: number; outbound: number };
    calls: { total: number; voiceMinutes: number; byOutcome: Record<string, number> };
    meetings: { total: number; upcoming: number };
  };
}

function toMap<T extends { t: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.t, r);
  return m;
}

export class AdminService {
  constructor(private db: Database) {}

  /**
   * The plan catalogue, for the operator choosing one while creating a workspace.
   *
   * Ordered by price so the list reads as a ladder, with the free internal tier first.
   */
  async listPlans() {
    return this.db
      .select({
        code: plans.code,
        name: plans.name,
        nameHe: plans.nameHe,
        monthlyPriceAgorot: plans.monthlyPriceAgorot,
        includedLeads: plans.includedLeads,
        overagePerLeadAgorot: plans.overagePerLeadAgorot,
        includedMinutes: plans.includedMinutes,
        overagePerMinuteAgorot: plans.overagePerMinuteAgorot,
        isActive: plans.isActive,
      })
      .from(plans)
      .orderBy(plans.monthlyPriceAgorot);
  }

  /**
   * What a tenant is on right now, and what its OPEN billing period is priced at — which are two
   * different questions the moment anyone changes a plan mid-month.
   *
   * `usage_periods` snapshots plan values when the period opens so that a later change cannot
   * reprice days already billed. Read on its own that sounds like an implementation detail; in
   * practice it is the difference between what the operator just promised a customer and what the
   * customer's current invoice will say. The plan-change route reports both for exactly that
   * reason.
   */
  async readBillingPosture(tenantId: string) {
    const [tenant] = await this.db
      .select({
        planCode: tenants.planCode,
        billingStatus: tenants.billingStatus,
        quotaEnforcement: tenants.quotaEnforcement,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const [open] = await this.db
      .select({
        periodStart: usagePeriods.periodStart,
        periodEnd: usagePeriods.periodEnd,
        planCode: usagePeriods.planCode,
        monthlyPriceAgorot: usagePeriods.monthlyPriceAgorot,
        includedLeads: usagePeriods.includedLeads,
        leadsUsed: usagePeriods.leadsUsed,
        // The bundle the customer is actually billed on, and what they have spent of it.
        includedMinutes: usagePeriods.includedMinutes,
        overagePerMinuteAgorot: usagePeriods.overagePerMinuteAgorot,
        secondsUsed: usagePeriods.secondsUsed,
        // Operator-only: what those minutes COST us. Never served to a tenant.
        measuredCostMilliAgorot: usagePeriods.measuredCostMilliAgorot,
      })
      .from(usagePeriods)
      .where(and(eq(usagePeriods.tenantId, tenantId), eq(usagePeriods.status, 'open')))
      .limit(1);

    // No open period is normal, not an error: one is created lazily on the tenant's first metered
    // unit. A tenant that has never had a lead or a call simply has nothing to reprice.
    return { ...tenant, openPeriod: open ?? null };
  }

  /**
   * The DIDs assigned to a tenant.
   *
   * There was no way to ask this anywhere — not in the API, not in the console — even though "which
   * number does this customer answer on" is the first question of any inbound support call. It also
   * gives `verify-tenant.mjs` the list it needs to check each number against the SIP trunk, which is
   * where the quiet failure lives: a row here with no trunk entry means calls are rejected before
   * our code runs and nothing logs it.
   */
  async tenantNumbers(tenantId: string) {
    return this.db
      .select({
        e164: phoneNumbers.e164,
        label: phoneNumbers.label,
        isActive: phoneNumbers.isActive,
        createdAt: phoneNumbers.createdAt,
      })
      .from(phoneNumbers)
      .where(eq(phoneNumbers.tenantId, tenantId))
      .orderBy(phoneNumbers.e164);
  }

  /** Every tenant with its measured rollup. Tenant counts are small; a handful of grouped scans. */
  async listTenants(): Promise<TenantRollup[]> {
    const [rows, leadRows, convoRows, msgRows, callRows, meetRows] = await Promise.all([
      this.db.select().from(tenants).orderBy(tenants.createdAt),
      this.db.select({ t: leads.tenantId, c: count() }).from(leads).groupBy(leads.tenantId),
      this.db.select({ t: conversations.tenantId, c: count() }).from(conversations).groupBy(conversations.tenantId),
      this.db.select({ t: messages.tenantId, c: count(), last: max(messages.createdAt) }).from(messages).groupBy(messages.tenantId),
      this.db.select({ t: callLearnings.tenantId, c: count(), secs: sum(callLearnings.durationSecs) }).from(callLearnings).groupBy(callLearnings.tenantId),
      this.db.select({ t: scheduledCalls.tenantId, c: count() }).from(scheduledCalls).groupBy(scheduledCalls.tenantId),
    ]);

    const lead = toMap(leadRows);
    const convo = toMap(convoRows);
    const msg = toMap(msgRows);
    const call = toMap(callRows);
    const meet = toMap(meetRows);

    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      isActive: t.isActive ?? true,
      hasApiKey: !!t.apiKeyHash,
      planCode: t.planCode ?? null,
      billingStatus: t.billingStatus ?? 'trialing',
      createdAt: t.createdAt,
      leads: Number(lead.get(t.id)?.c ?? 0),
      conversations: Number(convo.get(t.id)?.c ?? 0),
      messages: Number(msg.get(t.id)?.c ?? 0),
      calls: Number(call.get(t.id)?.c ?? 0),
      voiceMinutes: Math.round(Number(call.get(t.id)?.secs ?? 0) / 60),
      meetings: Number(meet.get(t.id)?.c ?? 0),
      lastActivityAt: msg.get(t.id)?.last ? new Date(msg.get(t.id)!.last as unknown as string).toISOString() : null,
    }));
  }

  /** System-wide KPIs for the operator overview. */
  async overview(): Promise<AdminOverview> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [tenantRows, leadsTotal, convosTotal, msgTotal, callsTotal, minsTotal, meetTotal, leads24, msg24, calls24] =
      await Promise.all([
        this.db.select({ isActive: tenants.isActive, c: count() }).from(tenants).groupBy(tenants.isActive),
        this.db.select({ c: count() }).from(leads),
        this.db.select({ c: count() }).from(conversations),
        this.db.select({ c: count() }).from(messages),
        this.db.select({ c: count() }).from(callLearnings),
        this.db.select({ s: sum(callLearnings.durationSecs) }).from(callLearnings),
        this.db.select({ c: count() }).from(scheduledCalls),
        this.db.select({ c: count() }).from(leads).where(gte(leads.createdAt, since)),
        this.db.select({ c: count() }).from(messages).where(gte(messages.createdAt, since)),
        this.db.select({ c: count() }).from(callLearnings).where(gte(callLearnings.createdAt, since)),
      ]);

    let active = 0;
    let suspended = 0;
    for (const r of tenantRows) {
      if (r.isActive === false) suspended += Number(r.c);
      else active += Number(r.c);
    }

    return {
      tenants: { total: active + suspended, active, suspended },
      totals: {
        leads: Number(leadsTotal[0]?.c ?? 0),
        conversations: Number(convosTotal[0]?.c ?? 0),
        messages: Number(msgTotal[0]?.c ?? 0),
        calls: Number(callsTotal[0]?.c ?? 0),
        meetings: Number(meetTotal[0]?.c ?? 0),
        voiceMinutes: Math.round(Number(minsTotal[0]?.s ?? 0) / 60),
      },
      last24h: { leads: Number(leads24[0]?.c ?? 0), messages: Number(msg24[0]?.c ?? 0), calls: Number(calls24[0]?.c ?? 0) },
    };
  }

  /** Deep stats for one tenant (drill-in). Never returns the api key hash. */
  async tenantDetail(id: string): Promise<TenantDetail> {
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundError('Tenant', id);

    const now = new Date();
    const [leadStatus, convoTotal, msgByDir, callOutcome, callMins, meetRows] = await Promise.all([
      this.db.select({ status: leads.status, c: count() }).from(leads).where(eq(leads.tenantId, id)).groupBy(leads.status),
      this.db.select({ c: count() }).from(conversations).where(eq(conversations.tenantId, id)),
      this.db.select({ direction: messages.direction, c: count() }).from(messages).where(eq(messages.tenantId, id)).groupBy(messages.direction),
      this.db.select({ outcome: callLearnings.outcome, c: count() }).from(callLearnings).where(eq(callLearnings.tenantId, id)).groupBy(callLearnings.outcome),
      this.db.select({ s: sum(callLearnings.durationSecs) }).from(callLearnings).where(eq(callLearnings.tenantId, id)),
      this.db.select({ upcoming: count() }).from(scheduledCalls).where(and(eq(scheduledCalls.tenantId, id), gte(scheduledCalls.scheduledAt, now))),
    ]);

    const [meetTotalRow] = await this.db.select({ c: count() }).from(scheduledCalls).where(eq(scheduledCalls.tenantId, id));

    const byStatus: Record<string, number> = {};
    let leadsTotal = 0;
    for (const r of leadStatus) { byStatus[r.status] = Number(r.c); leadsTotal += Number(r.c); }

    let inbound = 0;
    let outbound = 0;
    for (const r of msgByDir) {
      if (r.direction === 'inbound') inbound = Number(r.c);
      else if (r.direction === 'outbound') outbound = Number(r.c);
    }

    const byOutcome: Record<string, number> = {};
    let callsTotal = 0;
    for (const r of callOutcome) { byOutcome[r.outcome ?? 'unlabeled'] = Number(r.c); callsTotal += Number(r.c); }

    return {
      tenant: {
        id: t.id,
        name: t.name,
        slug: t.slug,
        isActive: t.isActive ?? true,
        hasApiKey: !!t.apiKeyHash,
        // Redacted for the operator console too. Being super-admin is a reason to see a tenant's
        // configuration, not a reason to ship their credentials to a browser — the ciphertext is
        // useless to an operator and the console is the one surface that can display every
        // tenant's at once.
        settings: redactSettings(t.settings),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        planCode: t.planCode ?? null,
        billingStatus: t.billingStatus,
        quotaEnforcement: t.quotaEnforcement,
        billingAnchorDay: t.billingAnchorDay,
      },
      stats: {
        leads: { total: leadsTotal, byStatus },
        conversations: Number(convoTotal[0]?.c ?? 0),
        messages: { total: inbound + outbound, inbound, outbound },
        calls: { total: callsTotal, voiceMinutes: Math.round(Number(callMins[0]?.s ?? 0) / 60), byOutcome },
        meetings: { total: Number(meetTotalRow?.c ?? 0), upcoming: Number(meetRows[0]?.upcoming ?? 0) },
      },
    };
  }
}
