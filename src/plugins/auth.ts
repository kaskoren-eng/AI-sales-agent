import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tenants } from '../db/schema/index.js';
import { UnauthorizedError } from '../shared/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    userId?: string;
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
      throw new UnauthorizedError('Missing authorization header');
    }

    const [scheme, token] = authHeader.split(' ');

    if (scheme === 'Bearer' && token) {
      // Try JWT first
      try {
        const decoded = await request.jwtVerify();
        request.tenantId = decoded.tenantId;
        request.userId = decoded.sub;
        request.authMethod = 'jwt';
        return;
      } catch {
        // Not a valid JWT — try as API key
      }

      // Try API key
      const hashedKey = hashApiKey(token);
      const [tenant] = await app.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, hashedKey))
        .limit(1);

      if (tenant) {
        request.tenantId = tenant.id;
        request.authMethod = 'api_key';
        return;
      }
    }

    throw new UnauthorizedError('Invalid credentials');
  });
});
