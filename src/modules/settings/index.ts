import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { settingsRoutes } from './settings.routes.js';

export default fp(async (app: FastifyInstance) => {
  await app.register(settingsRoutes);
});
