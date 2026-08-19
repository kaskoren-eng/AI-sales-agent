import { pgTable, uuid, varchar, integer, text, timestamp, index, customType } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Per-tenant knowledge base — the store behind voice RAG (see docs/voice-rag-plan.md, Phase R1).
 *
 * WHY THIS EXISTS: tenant knowledge (product facts, pricing, FAQ, objection answers) used to have
 * only one home — the static system prompt. That does not scale: every tenant's facts would have to
 * be stuffed into a prompt that is already ~2,700 tokens, and irrelevant knowledge competes for the
 * model's attention on every single turn. Here the facts live in rows, and a turn carries only the
 * 2-3 chunks that turn needs.
 *
 * pgvector inside our own Postgres, not a SaaS vector DB: tenant isolation stays a `WHERE
 * tenant_id =` clause in the database we already trust, there is no new vendor and no network hop on
 * the voice hot path, and SMB knowledge bases are hundreds-to-thousands of chunks — three or four
 * orders of magnitude below where a dedicated vector store starts to earn its keep. Verified
 * available on Railway (`vector` 0.8.2) and locally via `pgvector/pgvector:pg17`.
 */

/**
 * `vector(n)` — pgvector's type. Drizzle 0.39 ships a `vector` helper, but we declare our own so the
 * DIMENSION is written in exactly one place (`EMBEDDING_DIMENSIONS` below) and so the driver mapping
 * is explicit: pgvector accepts the Postgres array literal `[0.1,0.2,...]` on the way in and hands
 * back that same text form, which we parse to numbers on the way out.
 */
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string): number[] {
      return JSON.parse(value) as number[];
    },
  })(name);

/**
 * The embedding width every chunk is stored at. `text-embedding-3-small` is natively 1536.
 *
 * This number is baked into the column type, so changing it is a migration, not a config flip —
 * which is exactly why `knowledge_chunks` also stores `embedding_model` and `dims` per row: a future
 * model (or a shrunk dimension) can be back-filled alongside the old rows and cut over per tenant,
 * instead of requiring a stop-the-world re-embed of every tenant at once.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export const KNOWLEDGE_SOURCE_TYPES = ['upload', 'paste', 'url'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const KNOWLEDGE_STATUSES = ['processing', 'ready', 'failed'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/**
 * One uploaded/pasted document. `rawText` is kept so a document can be re-chunked and re-embedded
 * without asking the tenant to upload it again (a chunker improvement or a model change should never
 * cost the tenant their content).
 */
export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  sourceType: varchar('source_type', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).default('processing').notNull(),
  rawText: text('raw_text').notNull(),
  /** Populated only when `status = 'failed'` — the ingestion error, for the R3 dashboard to show. */
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('knowledge_documents_tenant_idx').on(table.tenantId),
  index('knowledge_documents_status_idx').on(table.tenantId, table.status),
]);

/**
 * One retrievable chunk. `content` is the CLEANED text — what actually reaches the model — so what
 * you read in this column is what the agent will say from.
 */
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  embedding: vector('embedding', EMBEDDING_DIMENSIONS).notNull(),
  /** Which model produced `embedding`. A query must only ever be compared against chunks embedded by
   * the SAME model — cosine distance between two different models' spaces is meaningless. */
  embeddingModel: varchar('embedding_model', { length: 64 }).notNull(),
  dims: integer('dims').notNull(),
  /** Position within the document, so retrieved chunks can be shown/ordered in source order. */
  chunkIndex: integer('chunk_index').notNull(),
  tokenCount: integer('token_count').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  // The hot path: `WHERE tenant_id = $1 ORDER BY embedding <=> $2`. The btree carries the tenant
  // filter; the HNSW index (added in the migration — drizzle-kit cannot express `USING hnsw`) serves
  // the ordering.
  index('knowledge_chunks_tenant_doc_idx').on(table.tenantId, table.documentId),
]);

export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;
export type NewKnowledgeDocument = typeof knowledgeDocuments.$inferInsert;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert;
