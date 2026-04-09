import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { conversations } from './conversations.js';

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  direction: varchar('direction', { length: 10 }).notNull(),
  role: varchar('role', { length: 20 }).notNull(),
  content: text('content').notNull(),
  contentType: varchar('content_type', { length: 20 }).default('text'),
  channelMsgId: varchar('channel_msg_id', { length: 255 }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('msgs_tenant_idx').on(table.tenantId),
  index('msgs_convo_idx').on(table.conversationId),
  index('msgs_created_idx').on(table.conversationId, table.createdAt),
]);
