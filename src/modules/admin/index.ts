import type { FastifyInstance } from 'fastify';
import { adminRoutes } from './admin.routes.js';

export default async function adminModule(app: FastifyInstance) {
  await app.register(adminRoutes);
}
