import type { FastifyRequest } from 'fastify';

export function getTenantId(request: FastifyRequest): string {
  const tenantId = (request as any).tenantId;
  if (!tenantId) {
    throw new Error('Tenant ID not resolved. Ensure auth plugin is registered.');
  }
  return tenantId as string;
}
