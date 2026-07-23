import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { leads } from '../../../db/schema/index.js';

/**
 * Meta's 24-hour customer-service window, tracked per lead.
 *
 * WhatsApp allows FREEFORM business messages only within 24h of the customer's last inbound
 * message; outside it, only pre-approved templates are allowed (and, per our policy, only with
 * recorded consent). This module is the single source of truth for that clock: every inbound
 * webhook stamps it, every outbound send consults it.
 *
 * Lead-flow reality this serves (Koren, 2026-07-21): intake pushes leads to click-to-WhatsApp;
 * ~30% open a session (window open → freeform), ~70% never message (template-only forever until
 * they reply).
 */

/**
 * Stamps `last_inbound_whatsapp_at` for the lead matching this phone — ONE tenant-scoped UPDATE
 * with the format-proof suffix match (no select round trip). Best-effort by contract: an inbound
 * message must be processed even if the stamp fails, so callers fire-and-forget with a catch.
 */
export async function touchWhatsappWindow(
  db: Database,
  tenantId: string,
  phone: string,
  at: Date = new Date(),
): Promise<void> {
  const suffix = phone.replace(/\D/g, '').slice(-9);
  if (suffix.length < 7) return;
  await db
    .update(leads)
    .set({ lastInboundWhatsappAt: at, updatedAt: at })
    .where(
      and(
        eq(leads.tenantId, tenantId),
        sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') LIKE ${`%${suffix}`}`,
      ),
    );
}
