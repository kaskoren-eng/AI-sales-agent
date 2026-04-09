import { pgTable, uuid, varchar, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('leads_tenant_idx').on(table.tenantId),
  index('leads_email_idx').on(table.tenantId, table.email),
  index('leads_phone_idx').on(table.tenantId, table.phone),
  index('leads_status_idx').on(table.tenantId, table.status),
]);
