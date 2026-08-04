import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.routes.js';

export default async function authModule(app: FastifyInstance) {
  await app.register(authRoutes);
}

export { AuthService } from './auth.service.js';
