import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TenantRole } from '../db/schema/index.js';
import { ForbiddenError } from '../shared/errors.js';

/**
 * Role hierarchy. Higher number implies every capability of the levels below it, so a check is a
 * comparison rather than a set membership test and adding a role later does not mean revisiting
 * every call site.
 */
const RANK: Record<TenantRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Guard for routes that a viewer (or a member) must not reach.
 *
 * API KEYS DELIBERATELY PASS. A tenant API key is a machine credential that predates roles and is
 * already tenant-wide and full-power; making it fail role checks would break every existing
 * integration the moment this shipped. The meaningful boundary it enforces is between *people* in
 * a workspace. If per-key scopes are wanted later, that is a property of the key, not of this
 * guard — and this comment is the place to notice the difference.
 */
export function requireRole(minimum: TenantRole) {
  return async function roleGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (request.authMethod === 'api_key') return;

    const role = request.role;
    if (!role || RANK[role] === undefined) {
      throw new ForbiddenError('Your account has no role in this workspace');
    }
    if (RANK[role] < RANK[minimum]) {
      throw new ForbiddenError(`This action requires the ${minimum} role`);
    }
  };
}

export const ROLE_RANK = RANK;
