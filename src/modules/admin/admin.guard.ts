import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AppError, UnauthorizedError } from '../../shared/errors.js';

/**
 * Gate for the operator console. Every `/api/v1/admin/*` route runs this on every request.
 *
 * - No `ADMIN_API_KEY` configured → 503. The console is opt-in; without the secret it does not exist,
 *   rather than silently allowing access.
 * - `Authorization: Bearer <ADMIN_API_KEY>` must match, compared in constant time so a wrong key
 *   can't be discovered by timing. Any mismatch → 401. The key is never logged.
 *
 * This is a SEPARATE credential from tenant API keys / JWTs — a tenant key can never reach admin
 * routes, and the admin key carries no tenant context (cross-tenant by design).
 */
export function requireAdmin(app: FastifyInstance) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const configured = app.env.ADMIN_API_KEY;
    if (!configured) {
      throw new AppError('Admin console is not configured', 503, 'ADMIN_NOT_CONFIGURED');
    }

    const authHeader = request.headers.authorization;
    const [scheme, token] = authHeader?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      request.log.warn({ audit: true, event: 'admin_auth_failure', reason: 'missing_bearer', ip: request.ip, url: request.url });
      throw new UnauthorizedError('Admin credentials required');
    }

    // Constant-time compare. timingSafeEqual throws on length mismatch, so guard with a length-safe
    // buffer comparison (equal-length buffers only).
    const a = Buffer.from(token);
    const b = Buffer.from(configured);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      request.log.warn({ audit: true, event: 'admin_auth_failure', reason: 'invalid_key', ip: request.ip, url: request.url });
      throw new UnauthorizedError('Invalid admin credentials');
    }
  };
}
