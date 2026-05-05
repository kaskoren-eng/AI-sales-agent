import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getTenantId } from '../../shared/tenant-context.js';
import { CsvImportService } from './csv-import.service.js';
import { importJobs } from '../../db/schema/index.js';
import { ValidationError, NotFoundError } from '../../shared/errors.js';

const importBodySchema = z.object({
  csvContent: z.string().min(1, 'csvContent is required'),
});

export async function integrationsRoutes(app: FastifyInstance) {
  const csvImportService = new CsvImportService(app);

  // CSV import — accepts JSON { csvContent: "..." }
  app.post('/import', async (request, reply) => {
    const tenantId = getTenantId(request);

    const parsed = importBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0]?.message ?? 'Invalid request body');
    }

    const { csvContent } = parsed.data;
    const result = await csvImportService.importFromCsv(tenantId, csvContent);

    reply.status(202).send(result);
  });

  // Import job status
  app.get('/import/:jobId', async (request) => {
    const tenantId = getTenantId(request);
    const { jobId } = request.params as { jobId: string };

    const [job] = await app.db
      .select({
        id: importJobs.id,
        status: importJobs.status,
        totalRows: importJobs.totalRows,
        processedRows: importJobs.processedRows,
        errors: importJobs.errors,
        createdAt: importJobs.createdAt,
        updatedAt: importJobs.updatedAt,
      })
      .from(importJobs)
      .where(and(eq(importJobs.id, jobId), eq(importJobs.tenantId, tenantId)))
      .limit(1);

    if (!job) {
      throw new NotFoundError('Import job', jobId);
    }

    return job;
  });

  // Google Sheets — stub, implementation pending
  app.post('/google-sheets/connect', async (request, reply) => {
    const tenantId = getTenantId(request);
    app.log.info({ tenantId }, 'Google Sheets connect request');
    reply.status(501).send({ error: 'NOT_IMPLEMENTED', message: 'Google Sheets integration coming soon' });
  });

  app.post('/google-sheets/sync', async (request, reply) => {
    const tenantId = getTenantId(request);
    app.log.info({ tenantId }, 'Google Sheets sync request');
    reply.status(501).send({ error: 'NOT_IMPLEMENTED', message: 'Google Sheets integration coming soon' });
  });
}
