import { pgTable, uuid, varchar, integer, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { leads } from './leads.js';
import { conversations } from './conversations.js';

export const scheduledCalls = pgTable('scheduled_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  leadId: uuid('lead_id').references(() => leads.id),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  provider: varchar('provider', { length: 20 }).default('trafft').notNull(),
  providerRef: varchar('provider_ref', { length: 255 }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  duration: integer('duration').default(30),
  status: varchar('status', { length: 20 }).default('pending').notNull(),
  attendees: jsonb('attendees').default([]),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('calls_tenant_idx').on(table.tenantId),
  index('calls_lead_idx').on(table.tenantId, table.leadId),
  index('calls_scheduled_idx').on(table.tenantId, table.scheduledAt),
]);
