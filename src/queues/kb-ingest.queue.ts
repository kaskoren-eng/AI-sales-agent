import type { Queue } from 'bullmq';

export interface KbIngestJob {
  tenantId: string;
  documentId: string;
}

/**
 * Ingestion is retried like every other job in this repo, and de-duplicated on the document id so a
 * double-submit of the same document cannot run two embedding passes concurrently (which would race
 * the delete-then-insert in IngestionService and could leave a partial chunk set).
 */
export function enqueueKbIngest(queue: Queue, job: KbIngestJob) {
  return queue.add('kb-ingest', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    jobId: `kb-ingest-${job.documentId}`,
  });
}
