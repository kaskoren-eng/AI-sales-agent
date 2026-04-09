import type { FastifyInstance } from 'fastify';
import { getTenantId } from '../../shared/tenant-context.js';

export async function integrationsRoutes(app: FastifyInstance) {
  // CSV import
  app.post('/import', async (request, reply) => {
    const tenantId = getTenantId(request);
    // TODO: Accept multipart file upload, pass to CsvImportService
    app.log.info({ tenantId }, 'Import request received');
    reply.status(202).send({ status: 'processing' });
  });

  // Google Sheets connection
  app.post('/google-sheets/connect', async (request, reply) => {
    const tenantId = getTenantId(request);
    // TODO: Initialize Google Sheets connection
    reply.status(200).send({ ok: true });
  });

  // CRM sync trigger
  app.post('/crm/sync', async (request, reply) => {
    const tenantId = getTenantId(request);
    // TODO: Trigger Nango CRM sync
    reply.status(202).send({ status: 'syncing' });
  });

  // Import job status
  app.get('/import/:jobId', async (request) => {
    const tenantId = getTenantId(request);
    const { jobId } = request.params as { jobId: string };
    // TODO: Return import job status from import_jobs table
    return { jobId, status: 'pending' };
  });
}
