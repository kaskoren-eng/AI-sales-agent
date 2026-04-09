import type { FastifyInstance } from 'fastify';
import { voiceRoutes } from './voice.routes.js';

export default async function voiceModule(app: FastifyInstance) {
  await app.register(voiceRoutes);
}
