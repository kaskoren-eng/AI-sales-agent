import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { leads } from './leads.js';

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  leadId: uuid('lead_id').notNull().references(() => leads.id),
  channel: varchar('channel', { length: 20 }).notNull(),
  channelRef: varchar('channel_ref', { length: 255 }),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  summary: text('summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('convos_tenant_idx').on(table.tenantId),
  index('convos_lead_idx').on(table.tenantId, table.leadId),
]);
