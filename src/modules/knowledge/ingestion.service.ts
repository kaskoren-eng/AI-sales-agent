import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { knowledgeDocuments, knowledgeChunks } from '../../db/schema/knowledge.js';
import type { KnowledgeSourceType } from '../../db/schema/knowledge.js';
import { AppError } from '../../shared/errors.js';
import { chunkText } from './chunker.js';
import type { EmbeddingService } from './embedding.service.js';

/**
 * Document in → chunks embedded and stored.
 *
 * Runs off the hot path (a BullMQ worker owns it), so it optimises for correctness and for being
 * re-runnable rather than for speed: `rawText` is kept on the document row, and re-ingesting a
 * document replaces its chunks wholesale. That makes a chunker improvement or an embedding-model
 * change a re-run, not a data-loss event.
 *
 * PII: document content may contain a tenant's customer data, so nothing here logs `content` or
 * `rawText` — only ids, counts and timings.
 */

export interface CreateDocumentInput {
  tenantId: string;
  title: string;
  sourceType: KnowledgeSourceType;
  rawText: string;
}

export interface IngestResult {
  documentId: string;
  chunks: number;
  tokens: number;
  ms: number;
}

export class IngestionService {
  constructor(
    private readonly db: Database,
    private readonly embeddings: EmbeddingService,
  ) {}

  /**
   * Record the document as `processing` and hand back its id. Separate from `ingest()` so the caller
   * gets a row to show immediately (the R3 dashboard lists it as processing) and the slow embedding
   * work happens in the worker.
   */
  async createDocument(input: CreateDocumentInput): Promise<string> {
    const text = input.rawText.trim();
    if (!text) {
      throw new AppError('Document is empty', 400, 'KNOWLEDGE_EMPTY_DOCUMENT');
    }
    const [row] = await this.db
      .insert(knowledgeDocuments)
      .values({
        tenantId: input.tenantId,
        title: input.title.slice(0, 200),
        sourceType: input.sourceType,
        status: 'processing',
        rawText: text,
      })
      .returning({ id: knowledgeDocuments.id });

    if (!row) {
      throw new AppError('Failed to create knowledge document', 500, 'KNOWLEDGE_DOCUMENT_INSERT_FAILED');
    }
    return row.id;
  }

  /**
   * Chunk → embed → replace the document's chunks, then mark it `ready`.
   *
   * Tenant-scoped at every statement. The delete-then-insert is what makes re-ingestion idempotent:
   * running this twice leaves one set of chunks, not two (duplicate chunks would both rank for the
   * same question and waste two of the three slots a turn has).
   */
  async ingest(tenantId: string, documentId: string): Promise<IngestResult> {
    const startedAt = Date.now();

    const [doc] = await this.db
      .select({ id: knowledgeDocuments.id, rawText: knowledgeDocuments.rawText })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.tenantId, tenantId)))
      .limit(1);

    if (!doc) {
      throw new AppError(`Knowledge document ${documentId} not found`, 404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    }

    try {
      const chunks = chunkText(doc.rawText);
      if (chunks.length === 0) {
        throw new AppError('Document produced no chunks after cleaning', 422, 'KNOWLEDGE_NO_CHUNKS');
      }

      const vectors = await this.embeddings.embedBatch(chunks.map((c) => c.content));

      await this.db
        .delete(knowledgeChunks)
        .where(and(eq(knowledgeChunks.documentId, documentId), eq(knowledgeChunks.tenantId, tenantId)));

      await this.db.insert(knowledgeChunks).values(
        chunks.map((chunk, i) => ({
          tenantId,
          documentId,
          content: chunk.content,
          embedding: vectors[i]!,
          embeddingModel: this.embeddings.model,
          dims: vectors[i]!.length,
          chunkIndex: chunk.chunkIndex,
          tokenCount: chunk.tokenCount,
        })),
      );

      await this.db
        .update(knowledgeDocuments)
        .set({ status: 'ready', error: null, updatedAt: new Date() })
        .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.tenantId, tenantId)));

      return {
        documentId,
        chunks: chunks.length,
        tokens: chunks.reduce((sum, c) => sum + c.tokenCount, 0),
        ms: Date.now() - startedAt,
      };
    } catch (err) {
      // Mark the row failed with the reason, so a tenant sees "failed: <why>" instead of a document
      // stuck on "processing" forever. Best-effort: if this update also fails, the original error is
      // what matters and still propagates to the worker's dead-letter path.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.db
          .update(knowledgeDocuments)
          .set({ status: 'failed', error: message.slice(0, 500), updatedAt: new Date() })
          .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.tenantId, tenantId)));
      } catch {
        // Swallowed deliberately — see above.
      }
      throw err;
    }
  }

  /** Create + ingest in one step. The CLI path; the queue path calls the two halves separately. */
  async createAndIngest(input: CreateDocumentInput): Promise<IngestResult> {
    const documentId = await this.createDocument(input);
    return this.ingest(input.tenantId, documentId);
  }

  /** Tenant-scoped delete. Chunks go with the document via ON DELETE CASCADE. */
  async deleteDocument(tenantId: string, documentId: string): Promise<void> {
    await this.db
      .delete(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.tenantId, tenantId)));
  }
}
