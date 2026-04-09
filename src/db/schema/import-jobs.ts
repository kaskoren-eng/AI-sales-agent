import { pgTable, uuid, varchar, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  source: varchar('source', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).default('pending').notNull(),
  totalRows: integer('total_rows').default(0),
  processedRows: integer('processed_rows').default(0),
  errors: jsonb('errors').default([]),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('import_jobs_tenant_idx').on(table.tenantId),
  index('import_jobs_status_idx').on(table.tenantId, table.status),
]);
