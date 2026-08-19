-- Voice RAG, Phase R1: per-tenant knowledge base (pgvector).
--
-- The extension MUST be created before the tables: knowledge_chunks.embedding is vector(1536), which
-- does not exist as a type until this runs. Verified available on Railway (vector 0.8.2) and locally
-- via the pgvector/pgvector:pg17 image -- plain postgres:17 does NOT ship it.
--
-- REVERSIBLE BY DESIGN: this migration only ADDS. No existing table is altered, so the down-path is
--   DROP TABLE knowledge_chunks; DROP TABLE knowledge_documents;
-- and no leads/calls/tenants data is at risk.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
-- pg_trgm powers the LEXICAL half of hybrid retrieval. Measured necessity, not a nice-to-have: on the
-- real Hebrew KB, text-embedding-3-small returned every chunk in a flat 0.26-0.33 band, ranking the
-- chunk literally headed "התנגדות - זה יקר" FOURTH for the query "זה יקר לי". word_similarity() scored
-- that same pair 0.70. Vector search alone is not good enough at Hebrew to ship on.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" varchar(64) NOT NULL,
	"dims" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"token_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"raw_text" text NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tenant_doc_idx" ON "knowledge_chunks" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_tenant_idx" ON "knowledge_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_status_idx" ON "knowledge_documents" USING btree ("tenant_id","status");--> statement-breakpoint
-- The vector index. drizzle-kit cannot express `USING hnsw`, so it lives here by hand -- which also
-- means a schema regeneration will NOT recreate it. If this index is ever dropped, retrieval still
-- returns correct rows (Postgres falls back to a sequential scan) but the latency budget is gone, so
-- treat its absence as a performance incident, not a correctness one.
--
-- HNSW over IVFFlat: HNSW needs no training pass and stays accurate as rows are added one document at
-- a time, which is exactly the write pattern here. Cosine ops to match the `<=>` operator that
-- RetrievalService orders by.
CREATE INDEX "knowledge_chunks_embedding_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- GIN trigram index for the lexical half. Like the HNSW index above, this is a latency structure: the
-- hybrid query is correct without it, just slower.
CREATE INDEX "knowledge_chunks_content_trgm_idx" ON "knowledge_chunks" USING gin ("content" gin_trgm_ops);
