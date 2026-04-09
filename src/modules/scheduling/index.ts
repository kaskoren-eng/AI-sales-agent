import type { FastifyInstance } from 'fastify';
import { schedulingRoutes } from './scheduling.routes.js';

export default async function schedulingModule(app: FastifyInstance) {
  await app.register(schedulingRoutes);
}
