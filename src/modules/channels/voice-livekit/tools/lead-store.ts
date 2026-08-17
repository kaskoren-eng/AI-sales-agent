import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../../db/client.js';
import { leads } from '../../../../db/schema/index.js';
import { meterLead } from '../../../billing/usage.service.js';

/**
 * Lead persistence shared by the voice tools — extracted from book-meeting.tool.ts once
 * capture_lead_info needed the exact same resolution logic mid-call.
 *
 * THE TWO INVARIANTS every function here keeps:
 *  1. TENANT-SCOPED, ALWAYS. Every WHERE carries tenantId. A voice call writing another
 *     tenant's lead is a data breach, not a bug.
 *  2. COALESCE, DON'T BLANK. A call teaches us fragments; a fragment must never erase a
 *     fuller record (a lead's CRM-sourced email doesn't vanish because the caller mumbled).
 */

/** Last 9 digits — enough to match an Israeli number across +972/0/dashed formats. */
export function phoneSuffix(raw: string): string {
  return raw.replace(/\D/g, '').slice(-9);
}

/** Format-proof tenant-scoped phone lookup (digits-only suffix compare in SQL). */
export async function findLeadIdByPhone(
  db: Database,
  tenantId: string,
  phone: string,
): Promise<string | null> {
  const suffix = phoneSuffix(phone);
  if (suffix.length < 7) return null;
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.tenantId, tenantId),
        sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') LIKE ${`%${suffix}`}`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface LeadContactInfo {
  name?: string;
  phone?: string;
  email?: string;
}

/**
 * Resolves the call's lead and backfills contact fields (never blanking existing values).
 * Resolution order: known leadId → phone match (info.phone, then callerPhone) → fresh insert.
 * `status` is set only when the CALLER of this function decides so (book_meeting passes
 * 'qualified'; capture_lead_info passes nothing — a mid-call fact is not a status decision).
 * Returns the lead id, or null only if even the insert failed.
 */
export async function upsertLead(
  db: Database,
  tenantId: string,
  identity: { leadId: string | null; callerPhone: string | null },
  info: LeadContactInfo,
  opts: { status?: string } = {},
): Promise<string | null> {
  const backfill = {
    ...(info.name ? { name: sql`coalesce(nullif(${leads.name}, ''), ${info.name})` } : {}),
    ...(info.email ? { email: sql`coalesce(nullif(${leads.email}, ''), ${info.email})` } : {}),
    ...(info.phone ? { phone: sql`coalesce(nullif(${leads.phone}, ''), ${info.phone})` } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    updatedAt: new Date(),
  };

  if (identity.leadId) {
    await db
      .update(leads)
      .set(backfill)
      .where(and(eq(leads.id, identity.leadId), eq(leads.tenantId, tenantId)));
    return identity.leadId;
  }

  const matchPhone = info.phone ?? identity.callerPhone;
  if (matchPhone) {
    const existing = await findLeadIdByPhone(db, tenantId, matchPhone);
    if (existing) {
      await db
        .update(leads)
        .set(backfill)
        .where(and(eq(leads.id, existing), eq(leads.tenantId, tenantId)));
      return existing;
    }
  }

  const inserted = await db
    .insert(leads)
    .values({
      tenantId,
      name: info.name,
      phone: info.phone ?? identity.callerPhone ?? undefined,
      email: info.email,
      source: 'voice-livekit',
      status: opts.status ?? 'new',
    })
    .returning({ id: leads.id });

  // BILLABLE — an inbound caller nobody had on file is a new lead by any definition.
  //
  // NOT awaited, and this is the one place in the meter where that is deliberate: this runs
  // MID-CALL, while a human is waiting for the agent to speak. A slow write here becomes dead air.
  // The unawaited promise is safe because meterLead swallows its own errors, and a lost write is
  // recoverable from `leads` by scripts/reconcile-usage.mjs.
  const leadId = inserted[0]?.id ?? null;
  if (leadId) void meterLead(db, { tenantId, leadId, source: 'voice-livekit' });
  return leadId;
}

/**
 * Records VERBAL WhatsApp consent — the voice-lead consent path. A phone lead never fills the
 * intake form; the moment he provides AND confirms his WhatsApp number for confirmations on a
 * recorded call, that IS consent, and the transcript is the proof. Never downgrades: an already
 * granted consent (any source) is left untouched.
 */
export async function grantWhatsappConsentVerbal(
  db: Database,
  tenantId: string,
  leadId: string,
  at: Date = new Date(),
): Promise<void> {
  await db
    .update(leads)
    .set({
      whatsappConsent: sql`CASE
        WHEN coalesce((${leads.whatsappConsent}->>'granted')::boolean, false) THEN ${leads.whatsappConsent}
        ELSE ${JSON.stringify({ granted: true, source: 'voice_verbal', at: at.toISOString() })}::jsonb
      END`,
      updatedAt: at,
    })
    .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));
}

/**
 * Merges qualification facts into `leads.metadata.qualification` WITHOUT touching unrelated
 * metadata keys (mondayItemId etc. must survive), and raises the score monotonically —
 * GREATEST(existing, floor), so a later hesitant note never erases an earlier hot signal.
 */
export async function mergeLeadQualification(
  db: Database,
  tenantId: string,
  leadId: string,
  patch: Record<string, unknown>,
  scoreFloor?: number,
): Promise<void> {
  const patchJson = JSON.stringify(patch);
  await db
    .update(leads)
    .set({
      metadata: sql`coalesce(${leads.metadata}, '{}'::jsonb) || jsonb_build_object(
        'qualification',
        coalesce(${leads.metadata}->'qualification', '{}'::jsonb) || ${patchJson}::jsonb
      )`,
      ...(scoreFloor !== undefined
        ? { score: sql`GREATEST(coalesce(${leads.score}, 0), ${scoreFloor})` }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));
}
