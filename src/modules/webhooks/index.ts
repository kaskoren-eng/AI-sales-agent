import type { FastifyInstance } from 'fastify';
import { leadIntakeRoutes } from './lead-intake.routes.js';
import { mondayWebhookRoutes } from './monday.webhook.routes.js';

export default async function leadIntakeModule(app: FastifyInstance) {
  await app.register(leadIntakeRoutes);
  await app.register(mondayWebhookRoutes, { prefix: '/monday' });
}
