import type { FastifyInstance } from 'fastify';
import { integrationsRoutes } from './integrations.routes.js';
import { mondayRoutes } from './monday/monday.routes.js';

export default async function integrationsModule(app: FastifyInstance) {
  await app.register(integrationsRoutes);
  await app.register(mondayRoutes, { prefix: '/monday' });
}
