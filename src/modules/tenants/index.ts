import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from './tenant.routes.js';

export default async function tenantsModule(app: FastifyInstance) {
  await app.register(tenantRoutes);
}
