import type { FastifyInstance } from 'fastify';
import { emailRoutes } from './email.routes.js';

export default async function emailModule(app: FastifyInstance) {
  await app.register(emailRoutes);
}
