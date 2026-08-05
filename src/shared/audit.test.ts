import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { recordAudit, actorFromRequest } from './audit.js';

/**
 * The audit trail's two non-obvious properties, both of which are easy to break by accident:
 *
 *  1. it never fails the action it describes
 *  2. the actor comes from what auth RESOLVED, never from what the caller claimed
 */

function fakeDb(opts: { fail?: boolean } = {}) {
  const values = vi.fn(async (_row: Record<string, unknown>) => {
    if (opts.fail) throw new Error('db down');
  });
  return { db: { insert: vi.fn(() => ({ values })) } as any, values };
}

describe('recordAudit', () => {
  it('writes the row', async () => {
    const { db, values } = fakeDb();
    await recordAudit(db, {
      tenantId: 't1',
      action: 'tenant.suspended',
      targetType: 'tenant',
      targetId: 't1',
      actorType: 'admin_key',
      actorLabel: 'operator_console',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        action: 'tenant.suspended',
        actorType: 'admin_key',
        actorLabel: 'operator_console',
        metadata: {},
      }),
    );
  });

  it('NEVER throws — a failed audit write must not fail the action', async () => {
    /**
     * The decisive property. If this insert can throw, then a database hiccup turns a successful
     * tenant suspension into a 500, and the operator retries an action that already happened. A
     * missing audit row is a smaller problem than an action whose outcome nobody can determine.
     */
    const { db } = fakeDb({ fail: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordAudit(db, { action: 'tenant.suspended', actorType: 'system' }),
    ).resolves.toBeUndefined();

    // Loudly, though — a silently broken audit trail is worse than none.
    expect(err).toHaveBeenCalledWith('audit_write_failed', expect.stringContaining('tenant.suspended'));
    err.mockRestore();
  });

  it('defaults the nullable columns rather than writing undefined', async () => {
    const { db, values } = fakeDb();
    await recordAudit(db, { action: 'lead.deleted', actorType: 'system' });

    const row = values.mock.calls[0][0];
    expect(row.tenantId).toBeNull();
    expect(row.actorUserId).toBeNull();
    expect(row.targetId).toBeNull();
    expect(row.metadata).toEqual({});
  });
});

describe('actorFromRequest — identity comes from auth, not from the caller', () => {
  it('attributes a JWT session to the user', () => {
    const req = { userId: 'u1', tenantId: 't1', authMethod: 'jwt', ip: '1.2.3.4' } as FastifyRequest;
    expect(actorFromRequest(req)).toEqual({
      actorUserId: 'u1',
      actorType: 'user',
      actorLabel: 'u1',
      ip: '1.2.3.4',
    });
  });

  it('attributes an API key to the tenant, since no human is behind it', () => {
    const req = { tenantId: 't1', authMethod: 'api_key', ip: '1.2.3.4' } as FastifyRequest;
    expect(actorFromRequest(req)).toEqual({
      actorUserId: null,
      actorType: 'api_key',
      actorLabel: 'api_key:t1',
      ip: '1.2.3.4',
    });
  });

  it('falls back to system rather than inventing an actor', () => {
    const req = { ip: '1.2.3.4' } as FastifyRequest;
    expect(actorFromRequest(req).actorType).toBe('system');
  });
});
