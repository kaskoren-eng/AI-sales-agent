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

/** The Meta customer-service window: freeform is allowed this long after the last inbound. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The template slots a tenant can configure (their own Twilio-approved Content SIDs). */
export const WHATSAPP_TEMPLATE_KEYS = [
  'meeting_confirmation',
  'reminder_t24',
  'reminder_t1',
  'first_touch', // wired into lead-intake in Workstream B/C2 — the plumbing is ready now
] as const;
export type WhatsappTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];
export type WhatsappTemplatesConfig = Partial<Record<WhatsappTemplateKey, { contentSid: string }>>;

/** Reads `settings.whatsapp_templates`, tolerating any malformed shape (→ empty config). */
export function resolveWhatsappTemplates(settings: unknown): WhatsappTemplatesConfig {
  const raw =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)['whatsapp_templates']
      : undefined;
  if (!raw || typeof raw !== 'object') return {};
  const out: WhatsappTemplatesConfig = {};
  for (const key of WHATSAPP_TEMPLATE_KEYS) {
    const entry = (raw as Record<string, unknown>)[key];
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).contentSid === 'string' &&
      ((entry as Record<string, unknown>).contentSid as string).length > 0
    ) {
      out[key] = { contentSid: (entry as { contentSid: string }).contentSid };
    }
  }
  return out;
}

export interface WhatsappSendDecision {
  mode: 'freeform' | 'template' | 'blocked';
  contentSid?: string;
  reason?: 'no_template' | 'no_consent' | 'provider_no_templates';
}

/**
 * The single decision every outbound WhatsApp must pass through:
 *
 *   window open (lead messaged us < 24h ago)  → FREEFORM — cheaper, natural, no consent needed
 *                                               (they initiated the conversation).
 *   window closed (business-initiated)        → TEMPLATE — and ONLY with BOTH a configured
 *                                               contentSid for this slot AND recorded consent.
 *                                               Missing either → BLOCKED (log, never send).
 *
 * The template config is the fallback DEFINITION; this window check decides usage automatically.
 * UChat has no template API, so out-of-window sends on a UChat-only tenant are blocked
 * (`providerSupportsTemplates: false`) — out-of-window freeform is undeliverable there anyway.
 */
export function resolveWhatsappSendMode(input: {
  lastInboundWhatsappAt: Date | string | null;
  consentGranted: boolean;
  templates: WhatsappTemplatesConfig;
  templateKey: WhatsappTemplateKey | null;
  providerSupportsTemplates: boolean;
  now?: Date;
}): WhatsappSendDecision {
  const now = input.now ?? new Date();
  const last = input.lastInboundWhatsappAt ? new Date(input.lastInboundWhatsappAt) : null;
  const windowOpen = last !== null && now.getTime() - last.getTime() < WHATSAPP_WINDOW_MS;

  if (windowOpen) return { mode: 'freeform' };

  if (!input.providerSupportsTemplates) return { mode: 'blocked', reason: 'provider_no_templates' };
  const contentSid = input.templateKey ? input.templates[input.templateKey]?.contentSid : undefined;
  if (!contentSid) return { mode: 'blocked', reason: 'no_template' };
  if (!input.consentGranted) return { mode: 'blocked', reason: 'no_consent' };
  return { mode: 'template', contentSid };
}

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
