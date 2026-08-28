import { pgTable, uuid, varchar, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * WhatsApp consent record — who said we may message them, and how we can prove it.
 * `source`: 'intake_form' (checkbox on the lead form) | 'voice_verbal' (confirmed their number
 * for confirmations on a recorded call — the transcript is the proof) | future sources.
 * Business-initiated (out-of-24h-window template) sends REQUIRE granted=true; freeform replies
 * inside an open session don't (they messaged us first).
 */
export interface WhatsappConsent {
  granted: boolean;
  source: string;
  at: string;
  ip?: string;
}

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  externalId: varchar('external_id', { length: 255 }),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  source: varchar('source', { length: 50 }),
  status: varchar('status', { length: 50 }).default('new').notNull(),
  score: integer('score').default(0),
  metadata: jsonb('metadata').default({}),
  // Meta's 24h customer-service window: freeform WhatsApp is allowed only within 24h of the
  // lead's LAST INBOUND message. Updated by every inbound WhatsApp webhook (UChat + Twilio).
  lastInboundWhatsappAt: timestamp('last_inbound_whatsapp_at', { withTimezone: true }),
  whatsappConsent: jsonb('whatsapp_consent').$type<WhatsappConsent>(),
  // Set by the voice agent's request_human_handoff tool. NULL = never asked; a timestamp is the
  // "urgent since" the dashboard sorts on. Deliberately NOT a status value — a lead can be both
  // `qualified` and urgent.
  handoffRequestedAt: timestamp('handoff_requested_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('leads_tenant_idx').on(table.tenantId),
  index('leads_email_idx').on(table.tenantId, table.email),
  index('leads_phone_idx').on(table.tenantId, table.phone),
  index('leads_status_idx').on(table.tenantId, table.status),
  index('leads_handoff_idx').on(table.tenantId, table.handoffRequestedAt),
]);
