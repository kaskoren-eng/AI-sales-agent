import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tenants } from '../db/schema/index.js';
import type { TenantRole } from '../db/schema/index.js';
import { UnauthorizedError } from '../shared/errors.js';
import { getTenantStatus, assertTenantUsable } from './tenant-status.js';
import { loadSession, assertSessionUsable, sessionRejection } from './auth-session.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    userId?: string;
    /** Present only on the JWT path — API keys are tenant-wide and carry no role. */
    role?: TenantRole;
    /** auth_sessions.id, for revocation and audit attribution. JWT path only. */
    sessionId?: string;
    authMethod: 'api_key' | 'jwt';
  }
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export default fp(async (app) => {
  // Register JWT
  await app.register(import('@fastify/jwt'), {
    secret: app.env.JWT_SECRET,
    cookie: { cookieName: 'access_token', signed: false },
  });

  await app.register(import('@fastify/cookie'));

  // Auth decorator — used by API routes (not webhooks)
  app.decorate('authenticate', async function (request: any, reply: any) {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      request.log.warn({
        audit: true,
        event: 'auth_failure',
        reason: 'missing_auth_header',
        ip: request.ip,
        method: request.method,
        url: request.url,
      });
      throw new UnauthorizedError('Missing authorization header');
    }

    const [scheme, token] = authHeader.split(' ');

    if (scheme === 'Bearer' && token) {
      // Try JWT first
      let decoded: { tenantId?: string; sub?: string; rol?: string; sid?: string } | null = null;
      try {
        decoded = await request.jwtVerify();
      } catch {
        // Not a valid JWT — fall through to API key check
      }

      if (decoded) {
        // A VERIFIED SIGNATURE IS NOT ENOUGH. Every access token must name a live session row —
        // see plugins/auth-session.ts for why. A token with no `sid`, or a `sid` that does not
        // resolve to an unrevoked, unexpired session belonging to the claimed tenant, is refused
        // no matter how validly it is signed. This is what makes a leaked JWT_SECRET useless on
        // its own: minting a token no longer grants access, because the attacker cannot also
        // create the session row it has to point at.
        if (!decoded.sid || !decoded.tenantId) {
          request.log.warn({
            audit: true,
            event: 'auth_failure',
            reason: 'jwt_missing_session_claim',
            ip: request.ip,
            method: request.method,
            url: request.url,
          });
          throw sessionRejection();
        }

        const result = assertSessionUsable(
          await loadSession(app.db, decoded.sid),
          decoded.tenantId,
        );
        if ('reason' in result) {
          request.log.warn({
            audit: true,
            event: 'auth_failure',
            reason: result.reason,
            sessionId: decoded.sid,
            ip: request.ip,
            method: request.method,
            url: request.url,
          });
          throw sessionRejection();
        }

        // Only now is the tenant known to be real. Suspension is checked against a 30s-TTL cache
        // that the admin PATCH busts explicitly.
        assertTenantUsable(await getTenantStatus(app, result.principal.tenantId));

        request.tenantId = result.principal.tenantId;
        request.userId = result.principal.userId;
        // Role comes from tenant_members, never from the token's claim — otherwise editing one
        // claim would be a privilege escalation.
        request.role = result.principal.role;
        request.sessionId = result.principal.sessionId;
        request.authMethod = 'jwt';
        return;
      }

      // Try API key
      const hashedKey = hashApiKey(token);
      const [tenant] = await app.db
        .select({ id: tenants.id, isActive: tenants.isActive })
        .from(tenants)
        .where(eq(tenants.apiKeyHash, hashedKey))
        .limit(1);

      if (tenant) {
        // No cache here on purpose: this path already pays a query, so reading isActive in the
        // same SELECT is free AND always fresh — strictly better than a cached check.
        assertTenantUsable({ exists: true, isActive: tenant.isActive !== false });

        request.tenantId = tenant.id;
        request.authMethod = 'api_key';
        return;
      }

      // Both JWT and API key failed
      request.log.warn({
        audit: true,
        event: 'auth_failure',
        reason: 'invalid_credentials',
        ip: request.ip,
        method: request.method,
        url: request.url,
        // Never log the token itself
      });
      throw new UnauthorizedError('Invalid credentials');
    }

    // Unrecognised auth scheme (not Bearer)
    request.log.warn({
      audit: true,
      event: 'auth_failure',
      reason: 'invalid_scheme',
      scheme: scheme ?? 'none',
      ip: request.ip,
      method: request.method,
      url: request.url,
    });
    throw new UnauthorizedError('Invalid credentials');
  });
});
