import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from './errors.js';

export function getTenantId(request: FastifyRequest): string {
  const tenantId = (request as any).tenantId;
  if (!tenantId) {
    throw new UnauthorizedError('Tenant ID not resolved. Ensure auth plugin is registered.');
  }
  return tenantId as string;
}
