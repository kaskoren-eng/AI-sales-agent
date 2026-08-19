import { Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { KbIngestJob } from '../kb-ingest.queue.js';
import type { Database } from '../../db/client.js';
import { knowledgeDocuments } from '../../db/schema/knowledge.js';
import { IngestionService } from '../../modules/knowledge/ingestion.service.js';
import { EmbeddingService } from '../../modules/knowledge/embedding.service.js';
import type { Env } from '../../config/env.js';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  deadLetterQueue: Queue;
}

/**
 * The 7th worker: knowledge-base ingestion (chunk → embed → store).
 *
 * Follows the csv-import shape deliberately — same retry/dead-letter contract, same "mark the row
 * failed, then rethrow" ordering — because operators debug all seven of these the same way (see
 * skills/debug).
 *
 * Never logs document content: a tenant's KB can hold their customers' details.
 */
export function createKbIngestWorker(deps: WorkerDeps) {
  const { db, env, redis, deadLetterQueue } = deps;

  const worker = new Worker<KbIngestJob>(
    'kb-ingest',
    async (job) => {
      const { tenantId, documentId } = job.data;

      // Constructed per job rather than per worker: a tenant without OPENAI_API_KEY configured should
      // fail this one job (visible on the document row), not prevent the worker from booting at all.
      const embeddings = new EmbeddingService(env);
      const ingestion = new IngestionService(db, embeddings);

      const result = await ingestion.ingest(tenantId, documentId);
      console.log(
        'kb_ingest_done',
        JSON.stringify({ tenantId, documentId, chunks: result.chunks, tokens: result.tokens, ms: result.ms }),
      );
      return result;
    },
    { connection: redis.duplicate(), concurrency: 2 },
  );

  worker.on('failed', async (job, err) => {
    console.error(`kb-ingest failed for job ${job?.id}:`, err.message);
    if (!job) return;

    const { tenantId, documentId } = job.data;

    // IngestionService already marks the row failed for errors it raises; this covers the rest
    // (infrastructure failures thrown before/around it) so no document is left stuck on 'processing'.
    try {
      await db
        .update(knowledgeDocuments)
        .set({ status: 'failed', error: err.message.slice(0, 500), updatedAt: new Date() })
        .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.tenantId, tenantId)));
    } catch (dbErr) {
      console.error('Failed to mark knowledge document failed:', dbErr);
    }

    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade ?? 0);
    if (attemptsLeft <= 0) {
      try {
        await deadLetterQueue.add(
          'kb-ingest-dead',
          { ...job.data, failedReason: err.message },
          { removeOnComplete: false, removeOnFail: false },
        );
      } catch (dlqErr) {
        console.error('Failed to enqueue dead letter for kb-ingest job:', dlqErr);
      }
    }
  });

  return worker;
}
