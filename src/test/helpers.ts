/**
 * Test helpers — builds a minimal Fastify app with mocked infrastructure.
 * No real DB, Redis, or queue connections are made.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { AppError } from '../shared/errors.js';

export type MockDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

export type MockQueue = {
  add: ReturnType<typeof vi.fn>;
};

export function createMockDb(): MockDb {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

export function createMockQueue(): MockQueue {
  return { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
}

/**
 * Creates a minimal Fastify app with mocked db/redis/queues.
 * Registers auth and audit plugins and any provided route modules.
 */
export async function buildTestApp(
  opts: {
    db?: MockDb;
    registerRoutes?: (app: FastifyInstance) => Promise<void>;
    envOverrides?: Record<string, string>;
  } = {},
): Promise<FastifyInstance> {
  const db = opts.db ?? createMockDb();
  const mockQueue = createMockQueue();

  // Minimal test env
  const env = {
    NODE_ENV: 'test' as const,
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent' as const,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: 'a'.repeat(64), // 32 bytes in hex
    JWT_SECRET: 'test-jwt-secret-minimum-16-chars',
    CORS_ORIGINS: 'http://localhost:3001',
    AI_MODEL: 'gemini-2.5-flash',
    ...opts.envOverrides,
  };

  const app = Fastify({ logger: false });

  // Decorate with env and mocked infrastructure
  app.decorate('env', env);
  app.decorate('db', db as any);
  app.decorate('redis', { duplicate: vi.fn() } as any);
  app.decorate('queues', {
    messageProcessor: mockQueue,
    outboundSender: mockQueue,
    flowExecutor: mockQueue,
  } as any);

  // Register JWT + cookie (needed by auth plugin logic)
  await app.register(import('@fastify/jwt'), {
    secret: env.JWT_SECRET,
  });
  await app.register(import('@fastify/cookie'));

  // Auth decorator
  app.decorate('authenticate', async function (request: any, reply: any) {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Missing authorization header' });
      return;
    }
    const [, token] = authHeader.split(' ');
    if (token === 'test-token') {
      request.tenantId = 'tenant-test-uuid';
      request.authMethod = 'api_key';
      return;
    }
    reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid credentials' });
  });

  // Audit hook (no-op in tests)
  app.addHook('onResponse', async () => {});

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // Error handler — must be registered before child plugins so it's in scope as fallback
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    reply.status((error as any).statusCode ?? 500).send({
      error: 'INTERNAL_ERROR',
      message: error.message,
    });
  });

  // Register caller-provided routes
  if (opts.registerRoutes) {
    await opts.registerRoutes(app);
  }

  await app.ready();
  return app;
}

/** Sign a JWT for testing authenticated routes */
export async function signTestJwt(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<string> {
  return app.jwt.sign(payload);
}
