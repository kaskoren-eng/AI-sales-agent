import type { FastifyInstance } from 'fastify';
import { integrationsRoutes } from './integrations.routes.js';

export default async function integrationsModule(app: FastifyInstance) {
  await app.register(integrationsRoutes);
}
