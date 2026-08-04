import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tenants } from '../db/schema/index.js';
import type { TenantRole } from '../db/schema/index.js';
import { UnauthorizedError } from '../shared/errors.js';
import { getTenantStatus, assertTenantUsable } from './tenant-status.js';

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
        // The JWT path touches no database of its own — request.tenantId is whatever the token
        // claims. That was harmless only while nothing minted JWTs; the moment login shipped this
        // became the PRIMARY auth path, so the suspension check has to live here too. Cached with
        // a 30s TTL that suspension busts explicitly, so this costs no query per request.
        const status = await getTenantStatus(app, decoded.tenantId!);
        assertTenantUsable(status);

        request.tenantId = decoded.tenantId!;
        request.userId = decoded.sub;
        request.role = decoded.rol as never;
        request.sessionId = decoded.sid;
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
