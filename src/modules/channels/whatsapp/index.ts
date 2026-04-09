import type { FastifyInstance } from 'fastify';
import { whatsappRoutes } from './whatsapp.routes.js';

export default async function whatsappModule(app: FastifyInstance) {
  await app.register(whatsappRoutes);
}
