import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAdmin } from './admin.guard.js';
import { AppError, UnauthorizedError } from '../../shared/errors.js';

function fakeApp(adminKey?: string): FastifyInstance {
  return { env: { ADMIN_API_KEY: adminKey } } as unknown as FastifyInstance;
}

function fakeReq(authorization?: string): FastifyRequest {
  return {
    headers: authorization ? { authorization } : {},
    ip: '127.0.0.1',
    url: '/api/v1/admin/overview',
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

const reply = {} as FastifyReply;

describe('requireAdmin', () => {
  it('503s when ADMIN_API_KEY is not configured — the console is opt-in', async () => {
    const guard = requireAdmin(fakeApp(undefined));
    await expect(guard(fakeReq('Bearer anything'), reply)).rejects.toMatchObject({
      constructor: AppError,
      statusCode: 503,
      code: 'ADMIN_NOT_CONFIGURED',
    });
  });

  it('401s when the Authorization header is missing', async () => {
    const guard = requireAdmin(fakeApp('a'.repeat(24)));
    await expect(guard(fakeReq(undefined), reply)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('401s on a non-Bearer scheme', async () => {
    const guard = requireAdmin(fakeApp('a'.repeat(24)));
    await expect(guard(fakeReq('Basic dXNlcjpwYXNz'), reply)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('401s when the key is wrong (and does not leak via length)', async () => {
    const guard = requireAdmin(fakeApp('a'.repeat(24)));
    await expect(guard(fakeReq('Bearer ' + 'b'.repeat(24)), reply)).rejects.toBeInstanceOf(UnauthorizedError);
    // Different length must also be rejected without throwing from timingSafeEqual.
    await expect(guard(fakeReq('Bearer short'), reply)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('passes when the Bearer token matches ADMIN_API_KEY exactly', async () => {
    const key = 'super-secret-operator-key-0001';
    const guard = requireAdmin(fakeApp(key));
    await expect(guard(fakeReq(`Bearer ${key}`), reply)).resolves.toBeUndefined();
  });
});
