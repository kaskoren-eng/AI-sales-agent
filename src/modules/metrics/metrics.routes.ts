import type { FastifyInstance } from 'fastify';
import { MetricsService, type MetricsRange } from './metrics.service.js';

const RANGES: MetricsRange[] = ['today', 'd7', 'd30'];

/**
 * Read-only dashboard metrics for the CALLER's tenant (`request.tenantId`). Runs under the API
 * scope's tenant auth, so it is always tenant-scoped — never cross-tenant. Powers the Overview
 * KPIs, pipeline, quality score, and the trend chart.
 */
export async function metricsRoutes(app: FastifyInstance) {
  const service = new MetricsService(app.db);

  app.get<{ Querystring: { range?: string } }>('/summary', async (request) => {
    const q = request.query.range;
    const range: MetricsRange = RANGES.includes(q as MetricsRange) ? (q as MetricsRange) : 'today';
    return service.summary(request.tenantId, range);
  });
}
