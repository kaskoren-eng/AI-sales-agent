import type { FastifyInstance } from 'fastify';
import callsRoutes from './calls.routes.js';
import monitorCallRoutes from './monitor-call.routes.js';

export default async function callsModule(app: FastifyInstance) {
  await app.register(callsRoutes);
  await app.register(monitorCallRoutes);
}
