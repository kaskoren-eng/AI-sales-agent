import type { FastifyInstance } from 'fastify';
import { importJobs } from '../../db/schema/index.js';
import { enqueueCsvImport } from '../../queues/csv-import.queue.js';

export class CsvImportService {
  constructor(private app: FastifyInstance) {}

  async importFromCsv(
    tenantId: string,
    csvContent: string,
  ): Promise<{ jobId: string; status: string }> {
    // Create the import_jobs row; CSV content is passed directly to the queue job
    const [job] = await this.app.db
      .insert(importJobs)
      .values({
        tenantId,
        source: 'csv',
        status: 'pending',
        totalRows: 0,
        processedRows: 0,
        errors: [],
        metadata: {},
      })
      .returning({ id: importJobs.id });

    const jobId = job.id;

    // Enqueue the BullMQ job carrying the CSV content
    await enqueueCsvImport(this.app.queues.csvImport, { jobId, tenantId, csvContent });

    this.app.log.info({ tenantId, jobId }, 'CSV import enqueued');

    return { jobId, status: 'pending' };
  }
}
