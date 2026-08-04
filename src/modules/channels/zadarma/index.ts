import type { FastifyInstance } from 'fastify';
import { zadarmaRoutes } from './zadarma.routes.js';

export default async function zadarmaModule(app: FastifyInstance) {
  await app.register(zadarmaRoutes);
}
