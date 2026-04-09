import type { FastifyInstance } from 'fastify';
import { leadRoutes } from './lead.routes.js';

export default async function leadsModule(app: FastifyInstance) {
  await app.register(leadRoutes);
}
