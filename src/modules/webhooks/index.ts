import type { FastifyInstance } from 'fastify';
import { leadIntakeRoutes } from './lead-intake.routes.js';

export default async function leadIntakeModule(app: FastifyInstance) {
  await app.register(leadIntakeRoutes);
}
