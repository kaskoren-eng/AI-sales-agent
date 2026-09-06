import { pgTable, uuid, varchar, integer, timestamp, jsonb, index, text } from 'drizzle-orm/pg-core';
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
  // Denormalised mirror of the earliest PENDING row in `callbacks` — so "who am I calling today"
  // is answerable without a join, on the dashboard and in a sweeper. NULL = nothing owed.
  // Deliberately NOT a status value, for the same reason as handoffRequestedAt above: a lead can
  // be `qualified` AND owed a callback, and LEAD_STATUSES is a state machine with transitions
  // (`lead-status.ts :: canTransition`) that a scheduling fact has no business entering.
  nextCallbackAt: timestamp('next_callback_at', { withTimezone: true }),
  // SOFT STOP — he told us he is not interested, without forbidding contact. The follow-up ladder
  // refuses to schedule or dial while this is set; a human may still reach out, and an inbound
  // message from HIM clears it. `stop-signals.ts` explains the three tiers.
  //
  // Deliberately NOT a lead status: `unreachable` and `disqualified` are outcomes of OUR process,
  // this is an instruction from HIM, and a lead can be `qualifying` and have asked us to stop
  // chasing in the same breath. A HARD stop, by contrast, IS a status — `opted_out` — because it
  // is permanent and every channel must honour it.
  followupStoppedAt: timestamp('followup_stopped_at', { withTimezone: true }),
  // His words, or the classifier's one-line reason. What a human reads before deciding to override.
  followupStopReason: text('followup_stop_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('leads_tenant_idx').on(table.tenantId),
  index('leads_email_idx').on(table.tenantId, table.email),
  index('leads_phone_idx').on(table.tenantId, table.phone),
  index('leads_status_idx').on(table.tenantId, table.status),
  index('leads_handoff_idx').on(table.tenantId, table.handoffRequestedAt),
  index('leads_callback_idx').on(table.tenantId, table.nextCallbackAt),
  index('leads_followup_stop_idx').on(table.tenantId, table.followupStoppedAt),
]);
