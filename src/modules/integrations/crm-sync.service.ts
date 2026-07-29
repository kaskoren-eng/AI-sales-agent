import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { tenants, leads, conversations } from '../../db/schema/index.js';
import { decrypt } from '../../shared/crypto.js';
import { canTransition } from '../leads/lead-status.js';
import { MondayService } from './monday/monday.service.js';
import { AirtableService } from './airtable/airtable.service.js';
import {
  resolveCrmSyncSettings,
  resolveLeadStatusForOutcome,
  type CrmSyncSettings,
} from './crm-sync.settings.js';

/**
 * Workstream B — after a voice call is analyzed, reflect the outcome in the tenant's connected CRM:
 * move the lead to the mapped pipeline status (B1). Everything here is PER-TENANT (which CRM, which
 * board/base, which column, which label) and BEST-EFFORT: this function never throws. A CRM being
 * down, misconfigured, or absent degrades to a log line — the call analysis that called us has
 * already been persisted and must complete regardless.
 */

export interface CrmSyncLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const consoleLogger: CrmSyncLogger = {
  info: (o, m) => console.log(m ?? 'crm_sync', JSON.stringify(o)),
  warn: (o, m) => console.warn(m ?? 'crm_sync', JSON.stringify(o)),
  error: (o, m) => console.error(m ?? 'crm_sync', JSON.stringify(o)),
};

export interface CrmSyncDeps {
  db: Database;
  encryptionKey: string;
  dashboardBaseUrl?: string;
  logger?: CrmSyncLogger;
}

export interface CrmSyncInput {
  tenantId: string;
  /** The Task-0 conversation for this call; the lead is resolved from it. */
  conversationId?: string;
  /** analysis.end_reason — the outcome Keren recorded. Drives the status change. */
  endReason?: string;
  /** analysis.summary — the GPT recap (used by B2). */
  summary?: string;
}

export interface CrmChannelResult {
  attempted: boolean;
  ok: boolean;
  statusPushed?: boolean;
  summaryPushed?: boolean;
  error?: string;
}

export interface CrmSyncResult {
  skipped?: 'disabled' | 'no_crm' | 'no_conversation' | 'no_lead' | 'no_status_change';
  /** The canonical status we moved (or would have moved) the lead to. */
  status?: string;
  localStatusUpdated?: boolean;
  monday?: CrmChannelResult;
  airtable?: CrmChannelResult;
}

/** Decrypt + build the Monday client for a tenant, or null if not connected/decryptable. */
function mondayFor(
  rawSettings: Record<string, unknown>,
  encryptionKey: string,
): { svc: MondayService; boardId: string; statusCol?: string } | null {
  const monday = rawSettings.monday as Record<string, any> | undefined;
  if (!monday?.encryptedApiToken || !monday.boardId) return null;
  try {
    const apiToken = decrypt(monday.encryptedApiToken, encryptionKey);
    const columnMap = monday.columnMap ?? {};
    return {
      svc: new MondayService({ apiToken, boardId: monday.boardId, columnMap }),
      boardId: monday.boardId,
      statusCol: columnMap.status,
    };
  } catch {
    return null;
  }
}

/** Decrypt + build the Airtable client for a tenant, or null if not connected/decryptable. */
function airtableFor(
  rawSettings: Record<string, unknown>,
  encryptionKey: string,
): AirtableService | null {
  const at = rawSettings.airtable as Record<string, any> | undefined;
  if (!at?.encryptedApiKey || !at.baseId || !at.tableId) return null;
  try {
    const apiKey = decrypt(at.encryptedApiKey, encryptionKey);
    return new AirtableService({
      apiKey,
      baseId: at.baseId,
      tableId: at.tableId,
      phoneFieldName: at.phoneFieldName,
      emailFieldName: at.emailFieldName,
    });
  } catch {
    return null;
  }
}

type LeadRow = typeof leads.$inferSelect;

/** Find the Monday item for this lead, creating it if the tenant hasn't linked one yet. */
async function resolveMondayItemId(
  deps: CrmSyncDeps,
  monday: { svc: MondayService; boardId: string },
  tenantId: string,
  lead: LeadRow,
): Promise<string> {
  const meta = (lead.metadata as Record<string, any>) ?? {};
  if (meta.mondayItemId) return meta.mondayItemId as string;

  const itemId = await monday.svc.createItem(
    monday.boardId,
    lead.name ?? lead.email ?? lead.phone ?? 'Lead',
    monday.svc.buildColumnValues(lead),
  );
  await deps.db
    .update(leads)
    .set({ metadata: { ...meta, mondayItemId: itemId }, updatedAt: new Date() })
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, lead.id)));
  return itemId;
}

/** Find the Airtable record for this lead (linked id → phone → email), creating it if none. */
async function resolveAirtableRecordId(
  deps: CrmSyncDeps,
  svc: AirtableService,
  tenantId: string,
  lead: LeadRow,
): Promise<string> {
  const meta = (lead.metadata as Record<string, any>) ?? {};
  if (meta.airtableRecordId) return meta.airtableRecordId as string;

  let record = lead.phone ? await svc.findByPhone(lead.phone) : null;
  if (!record && lead.email) record = await svc.findByEmail(lead.email);

  const recordId = record
    ? record.id
    : await svc.createRecord({
        ...(lead.name ? { Name: lead.name } : {}),
        ...(lead.email ? { Email: lead.email } : {}),
        ...(lead.phone ? { Phone: lead.phone } : {}),
      });

  await deps.db
    .update(leads)
    .set({ metadata: { ...meta, airtableRecordId: recordId }, updatedAt: new Date() })
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, lead.id)));
  return recordId;
}

export async function syncCallToCrm(deps: CrmSyncDeps, input: CrmSyncInput): Promise<CrmSyncResult> {
  const log = deps.logger ?? consoleLogger;
  const { tenantId } = input;

  try {
    // 1. Load tenant settings once; resolve the sync behavior.
    const [tenant] = await deps.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const rawSettings = (tenant?.settings as Record<string, unknown>) ?? {};
    const settings: CrmSyncSettings = resolveCrmSyncSettings(rawSettings);

    if (!settings.enabled) {
      log.info({ event: 'crm_sync_skipped', tenantId, reason: 'disabled' });
      return { skipped: 'disabled' };
    }

    // 2. Which CRMs are connected? No CRM → nothing to do, silently.
    const monday = mondayFor(rawSettings, deps.encryptionKey);
    const airtable = airtableFor(rawSettings, deps.encryptionKey);
    if (!monday && !airtable) {
      log.info({ event: 'crm_sync_skipped', tenantId, reason: 'no_crm' });
      return { skipped: 'no_crm' };
    }

    // 3. Resolve the lead from the call's conversation (tenant-scoped join).
    if (!input.conversationId) {
      log.warn({ event: 'crm_sync_skipped', tenantId, reason: 'no_conversation' });
      return { skipped: 'no_conversation' };
    }
    const [convo] = await deps.db
      .select({ leadId: conversations.leadId })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, input.conversationId)))
      .limit(1);
    if (!convo) {
      log.warn({ event: 'crm_sync_skipped', tenantId, reason: 'no_conversation' });
      return { skipped: 'no_conversation' };
    }
    const [lead] = await deps.db
      .select()
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.id, convo.leadId)))
      .limit(1);
    if (!lead) {
      log.warn({ event: 'crm_sync_skipped', tenantId, reason: 'no_lead' });
      return { skipped: 'no_lead' };
    }

    const result: CrmSyncResult = { localStatusUpdated: false };

    // 4. B1 — outcome → canonical status. `null` means "no status change for this outcome".
    //    Update OUR lead first, respecting the shared transition guard, and decide what status (if
    //    any) to reflect on the CRM board. A blocked transition (e.g. opted_out → qualified) is
    //    never pushed; a lead already at the target (book_meeting set it live) is pushed but not
    //    re-written locally.
    const target = resolveLeadStatusForOutcome(input.endReason, settings);
    let statusToPush: string | null = null;
    let effectiveStatus = lead.status;
    if (target) {
      result.status = target;
      if (canTransition(lead.status, target)) {
        const meta = (lead.metadata as Record<string, any>) ?? {};
        const nextMeta: Record<string, any> = { ...meta, lastCallOutcome: input.endReason };
        if (target === 'disqualified') nextMeta.disqualifyReason = input.endReason;
        await deps.db
          .update(leads)
          .set({ status: target, metadata: nextMeta, updatedAt: new Date() })
          .where(and(eq(leads.tenantId, tenantId), eq(leads.id, lead.id)));
        effectiveStatus = target;
        result.localStatusUpdated = true;
        statusToPush = target;
      } else if (lead.status === target) {
        statusToPush = target;
      } else {
        log.warn({ event: 'crm_sync_transition_blocked', tenantId, leadId: lead.id, from: lead.status, to: target });
      }
    }

    // 5. B2 — the GPT call summary as a CRM note/field (opt-out via settings.pushSummary).
    const summaryNote =
      settings.pushSummary && input.summary ? buildSummaryNote(input, lead, deps.dashboardBaseUrl) : null;

    if (!statusToPush && !summaryNote) {
      log.info({ event: 'crm_sync_no_op', tenantId, leadId: lead.id, endReason: input.endReason });
      return { ...result, skipped: 'no_status_change' };
    }

    // 6. Push status + summary to each connected CRM in ONE pass (resolve the item/record once),
    //    isolated — one CRM's failure never blocks the other.
    const leadForPush: LeadRow = { ...lead, status: effectiveStatus };
    if (monday) {
      result.monday = await syncMonday(deps, monday, settings, tenantId, leadForPush, statusToPush, summaryNote);
    }
    if (airtable) {
      result.airtable = await syncAirtable(deps, airtable, settings, tenantId, leadForPush, statusToPush, summaryNote);
    }

    log.info({
      event: 'crm_sync_done',
      tenantId,
      leadId: lead.id,
      status: result.status,
      localStatusUpdated: result.localStatusUpdated,
      summary: Boolean(summaryNote),
      monday: result.monday?.ok,
      airtable: result.airtable?.ok,
    });
    return result;
  } catch (err) {
    // Absolute backstop: nothing in CRM sync may bubble up into the call-analysis job.
    log.error(
      { event: 'crm_sync_failed', tenantId, error: err instanceof Error ? err.message : String(err) },
      'crm_sync_failed',
    );
    return {};
  }
}

/**
 * The call summary as a plain-text CRM note: the GPT recap, the structured facts Keren captured
 * (business/pain/budget/timeline/qualification live in lead.metadata.qualification), the outcome,
 * and a back-link to the call in our dashboard (omitted if no dashboard URL is configured).
 */
function buildSummaryNote(input: CrmSyncInput, lead: LeadRow, dashboardBaseUrl?: string): string {
  const meta = (lead.metadata as Record<string, any>) ?? {};
  const q = (meta.qualification as Record<string, any>) ?? {};
  const lines: string[] = ['📞 סיכום שיחה — קרן'];
  if (input.summary) lines.push('', input.summary);

  const facts: string[] = [];
  if (q.business_type) facts.push(`עסק: ${q.business_type}`);
  if (q.pain_point) facts.push(`כאב: ${q.pain_point}`);
  if (q.budget) facts.push(`תקציב: ${q.budget}`);
  if (q.timeline) facts.push(`לו"ז: ${q.timeline}`);
  if (q.qualification) facts.push(`סיווג: ${q.qualification}`);
  if (input.endReason) facts.push(`תוצאה: ${input.endReason}`);
  if (facts.length) lines.push('', ...facts);

  if (dashboardBaseUrl && input.conversationId) {
    lines.push('', `צפייה בשיחה: ${dashboardBaseUrl.replace(/\/+$/, '')}/calls/${input.conversationId}`);
  }
  return lines.join('\n');
}

/** Push status (mapped label) and/or the summary note to Monday, resolving the item once. */
async function syncMonday(
  deps: CrmSyncDeps,
  monday: { svc: MondayService; boardId: string; statusCol?: string },
  settings: CrmSyncSettings,
  tenantId: string,
  lead: LeadRow,
  statusToPush: string | null,
  summaryNote: string | null,
): Promise<CrmChannelResult> {
  try {
    const itemId = await resolveMondayItemId(deps, monday, tenantId, lead);
    let statusPushed = false;
    let summaryPushed = false;

    if (statusToPush && monday.statusCol) {
      const label = settings.monday.statusLabels[statusToPush] ?? statusToPush;
      const cols = monday.svc.buildColumnValues(lead);
      cols[monday.statusCol] = label; // the tenant's own label wins over our canonical string
      await monday.svc.updateItem(monday.boardId, itemId, cols);
      statusPushed = true;
    }
    if (summaryNote) {
      await monday.svc.addUpdate(itemId, summaryNote);
      summaryPushed = true;
    }
    return { attempted: true, ok: true, statusPushed, summaryPushed };
  } catch (err) {
    deps.logger?.error?.({ event: 'crm_sync_monday_failed', tenantId, error: String(err) });
    return { attempted: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Push status (mapped value) and/or the summary field to Airtable in ONE PATCH, record resolved once. */
async function syncAirtable(
  deps: CrmSyncDeps,
  svc: AirtableService,
  settings: CrmSyncSettings,
  tenantId: string,
  lead: LeadRow,
  statusToPush: string | null,
  summaryNote: string | null,
): Promise<CrmChannelResult> {
  const { statusFieldName, summaryFieldName, statusValues } = settings.airtable;
  const fields: Record<string, unknown> = {};
  if (statusToPush && statusFieldName) fields[statusFieldName] = statusValues[statusToPush] ?? statusToPush;
  if (summaryNote && summaryFieldName) fields[summaryFieldName] = summaryNote;

  if (Object.keys(fields).length === 0) {
    // Nothing the tenant has told us where to write (no status field / no summary field mapped).
    return { attempted: true, ok: true, statusPushed: false, summaryPushed: false };
  }
  try {
    const recordId = await resolveAirtableRecordId(deps, svc, tenantId, lead);
    await svc.updateRecord(recordId, fields);
    return {
      attempted: true,
      ok: true,
      statusPushed: Boolean(statusToPush && statusFieldName),
      summaryPushed: Boolean(summaryNote && summaryFieldName),
    };
  } catch (err) {
    deps.logger?.error?.({ event: 'crm_sync_airtable_failed', tenantId, error: String(err) });
    return { attempted: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
