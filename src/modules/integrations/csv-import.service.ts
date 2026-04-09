import type { FastifyInstance } from 'fastify';

export class CsvImportService {
  constructor(private app: FastifyInstance) {}

  async importFromCsv(tenantId: string, fileBuffer: Buffer): Promise<{ jobId: string }> {
    // TODO: Parse CSV with papaparse, create import_job, enqueue bulk lead creation
    this.app.log.info({ tenantId, size: fileBuffer.length }, 'CSV import started');
    return { jobId: 'placeholder' };
  }
}
