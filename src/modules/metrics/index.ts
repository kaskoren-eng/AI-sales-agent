import type { FastifyInstance } from 'fastify';
import { metricsRoutes } from './metrics.routes.js';

export default async function metricsModule(app: FastifyInstance) {
  await app.register(metricsRoutes);
}
