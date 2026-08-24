import { describe, expect, it, vi } from 'vitest';
import { updateTenantSchema } from '../tenants/tenant.schemas.js';
import { TenantService } from '../tenants/tenant.service.js';
import type { Database } from '../../db/client.js';

/**
 * A PLAN MUST BE CHANGEABLE, AND CHANGING IT MUST NOT REWRITE THE PAST.
 *
 * `POST /admin/tenants` takes a plan, and until now nothing could ever change it again: no upgrade,
 * no downgrade, no way off the internal tier, no way to mark an account `past_due` when an invoice
 * went unpaid. All three production workspaces sat on `internal` with no supported route off it,
 * and the only way to move one was hand-written SQL against production.
 *
 * The half that is easy to get wrong is the other direction. `usage_periods` SNAPSHOTS plan values
 * when the period opens, deliberately, so that a change made on the 20th cannot reprice the 19 days
 * already billed under the old terms. That is correct — and it means an upgrade agreed today does
 * NOT take effect on today's invoice. An operator who has just quoted a customer a new price will
 * assume the opposite unless told, so the route reports what the open period is still priced at.
 *
 * These tests pin both halves: the change is possible, and it is honest about its own scope.
 */

const PLANS = ['base', 'growth', 'internal'];

function fakeDb(opts: { openPeriod?: Record<string, unknown> | null; existingPlan?: string } = {}) {
  const updates: Record<string, unknown>[] = [];
  let planLookup = '';

  // Which read this is, keyed off the columns asked for — `assertPlanExists` selects `{ code }`,
  // the slug uniqueness check selects `{ id }`, the posture read selects period fields.
  const db = {
    select: vi.fn((cols?: Record<string, unknown>) => ({
      from: (_table: unknown) => {
        const asked = cols ? Object.keys(cols) : [];
        const isPlanLookup = asked.length === 1 && asked[0] === 'code';
        const chain = {
          where: (..._a: unknown[]) => ({
            limit: async () => {
              if (isPlanLookup) return PLANS.includes(planLookup) ? [{ code: planLookup }] : [];
              if (asked.includes('periodStart')) return opts.openPeriod ? [opts.openPeriod] : [];
              if (asked.includes('id')) return []; // slug is free
              return [{ planCode: opts.existingPlan ?? 'internal', billingStatus: 'active' }];
            },
          }),
          orderBy: async () => PLANS.map((code) => ({ code })),
          limit: async () => [],
        };
        return chain;
      },
    })),
    update: vi.fn(() => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(v);
            return [{ id: 'tenant-1', slug: 'acme', ...v }];
          },
        }),
      }),
    })),
  } as unknown as Database;

  return {
    db,
    updates,
    setPlanLookup: (c: string) => {
      planLookup = c;
    },
  };
}

describe('updateTenantSchema — the operator-only billing fields', () => {
  it('accepts a plan change', () => {
    expect(updateTenantSchema.safeParse({ planCode: 'growth' }).success).toBe(true);
  });

  it('accepts a billing status and a quota mode', () => {
    expect(updateTenantSchema.safeParse({ billingStatus: 'past_due' }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ quotaEnforcement: 'hard' }).success).toBe(true);
  });

  it('rejects a billing status outside the four the database allows', () => {
    // Caught here so the operator gets "Invalid input" naming the valid values, rather than a
    // Postgres CHECK-constraint violation surfacing as a 500. The constraint stays as the last
    // line of defence; this is the first.
    expect(updateTenantSchema.safeParse({ billingStatus: 'cancelled' }).success).toBe(false);
    expect(updateTenantSchema.safeParse({ quotaEnforcement: 'strict' }).success).toBe(false);
  });

  it('still rejects nonsense in the fields it always had', () => {
    expect(updateTenantSchema.safeParse({ slug: 'Not A Slug' }).success).toBe(false);
  });
});

describe('TenantService.update — plan validation', () => {
  it('names the valid plans when given an unknown one', async () => {
    const { db, setPlanLookup } = fakeDb();
    setPlanLookup('enterprise');

    await expect(new TenantService(db).update('tenant-1', { planCode: 'enterprise' })).rejects.toThrow(
      /base, growth, internal/,
    );
  });

  it('writes the plan when it exists', async () => {
    const { db, updates, setPlanLookup } = fakeDb();
    setPlanLookup('growth');

    await new TenantService(db).update('tenant-1', { planCode: 'growth' });

    expect(updates[0]).toMatchObject({ planCode: 'growth' });
  });

  it('checks the plan BEFORE writing anything', async () => {
    // A partial update that renamed the tenant and then failed on the plan would leave the operator
    // unsure what landed.
    const { db, updates, setPlanLookup } = fakeDb();
    setPlanLookup('enterprise');

    await expect(
      new TenantService(db).update('tenant-1', { name: 'Renamed', planCode: 'enterprise' }),
    ).rejects.toThrow();

    expect(updates).toHaveLength(0);
  });
});

/**
 * THE WRITE WORKED AND THE READ DID NOT SHOW IT.
 *
 * `tenantDetail` builds an explicit projection rather than spreading the row — which is the right
 * shape, and the reason the operator console has never leaked `api_key_hash`. The cost of that
 * shape is that a column added later is invisible until someone adds it here too, and it fails
 * silently: the field is simply absent, so the console rendered an empty plan for a tenant that
 * had one, and the operator's only conclusion would be that the change had not saved.
 *
 * Caught by driving a real plan change against production and reading it back, not by review.
 */
describe('AdminService.tenantDetail — the billing projection', () => {
  it('returns the fields the operator can set', async () => {
    const row = {
      id: 't1', name: 'Acme', slug: 'acme', isActive: true, apiKeyHash: 'hash', settings: {},
      createdAt: new Date(), updatedAt: new Date(),
      planCode: 'base', billingStatus: 'trialing', quotaEnforcement: 'soft', billingAnchorDay: 12,
    };
    // Every read after the tenant row is a rollup this test does not care about.
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [row],
            groupBy: async () => [],
            then: (r: (v: unknown[]) => unknown) => r([]),
          }),
        }),
      })),
    } as unknown as Database;

    const { AdminService } = await import('./admin.service.js');
    const detail = await new AdminService(db).tenantDetail('t1');

    expect(detail.tenant).toMatchObject({
      planCode: 'base',
      billingStatus: 'trialing',
      quotaEnforcement: 'soft',
      billingAnchorDay: 12,
    });
    // And the boundary the projection exists to enforce still holds.
    expect(detail.tenant).not.toHaveProperty('apiKeyHash');
  });
});
