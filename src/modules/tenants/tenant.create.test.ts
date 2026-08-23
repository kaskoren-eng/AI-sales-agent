import { describe, expect, it, vi } from 'vitest';
import { TenantService } from './tenant.service.js';
import { createTenantSchema } from './tenant.schemas.js';
import type { Database } from '../../db/client.js';

/**
 * WHAT IT TAKES TO CREATE A WORKSPACE.
 *
 * Two things were wrong here, and both were found by onboarding a fresh tenant end to end rather
 * than by reading the code.
 *
 * 1. THE PLAN WAS OPTIONAL, AND ITS ABSENCE MEANT FREE. A tenant with no `plan_code` resolves
 *    through `readEffectivePlan` to `{ monthlyPriceAgorot: 0, includedLeads: null,
 *    overagePerLeadAgorot: 0 }`. That would be survivable if it were correctable — but
 *    `usage_periods` SNAPSHOTS the plan when the period opens, deliberately, so that a mid-month
 *    change cannot reprice history. The free-unlimited snapshot is therefore frozen for the
 *    customer's whole first month, and assigning the real plan afterwards does not fix the month
 *    you most want to bill for. The most permissive possible outcome was the default, and the
 *    mistake was unrecoverable by design.
 *
 * 2. THE RESPONSE SPREAD THE ROW. `return { ...tenant, apiKey }` published `api_key_hash` — the
 *    stored credential — and `settings`, which on an established tenant holds encrypted
 *    integration secrets. A row shape and a response shape are different things; spreading one
 *    into the other means every column added later is exposed by default.
 */

/** A db double shaped like the two reads and one write `create()` performs, in order. */
function fakeDb(opts: { slugTaken?: boolean; knownPlans?: string[] } = {}) {
  const knownPlans = opts.knownPlans ?? ['base', 'growth', 'internal'];
  const inserted: Record<string, unknown>[] = [];
  let selectCall = 0;

  const db = {
    select: vi.fn((_cols?: unknown) => ({
      from: (table: { _?: { name?: string } }) => {
        const name = (table as unknown as { [k: symbol]: unknown; _?: { name?: string } })?._?.name;
        const chain = {
          where: () => ({
            limit: async () => {
              selectCall += 1;
              // First read is the slug check, second is the plan check.
              if (selectCall === 1) return opts.slugTaken ? [{ id: 'existing' }] : [];
              return knownPlans.includes(lastPlanLookup) ? [{ code: lastPlanLookup }] : [];
            },
          }),
          // The "what plans exist" read used to build the error message.
          orderBy: async () => knownPlans.map((code) => ({ code })),
        };
        void name;
        return chain;
      },
    })),
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [
            {
              id: 'tenant-1',
              name: v.name,
              slug: v.slug,
              planCode: v.planCode,
              billingStatus: 'trialing',
              isActive: true,
              createdAt: new Date('2026-08-23T00:00:00Z'),
              // The two that must never reach a response.
              apiKeyHash: v.apiKeyHash,
              settings: { monday: { encryptedApiToken: 'ciphertext' } },
            },
          ];
        },
      }),
    })),
  } as unknown as Database;

  return { db, inserted };
}

/** `create()` reads the plan by code; the double needs to know which one was asked for. */
let lastPlanLookup = '';
const makeService = (opts?: Parameters<typeof fakeDb>[0]) => {
  const { db, inserted } = fakeDb(opts);
  return { svc: new TenantService(db), inserted };
};

describe('createTenantSchema', () => {
  it('rejects a workspace with no plan', () => {
    // Not defaulted on purpose. A default would only choose which wrong answer to be silent
    // about; whoever creates a workspace has just agreed a price with the customer.
    const parsed = createTenantSchema.safeParse({ name: 'Acme Dental', slug: 'acme-dental' });

    expect(parsed.success).toBe(false);
  });

  it('accepts one with a plan', () => {
    const parsed = createTenantSchema.safeParse({
      name: 'Acme Dental',
      slug: 'acme-dental',
      planCode: 'base',
    });

    expect(parsed.success).toBe(true);
  });
});

describe('TenantService.create', () => {
  it('persists the plan, so the first usage period snapshots a real price', async () => {
    lastPlanLookup = 'growth';
    const { svc, inserted } = makeService();

    await svc.create({ name: 'Acme Dental', slug: 'acme-dental', planCode: 'growth' });

    expect(inserted[0]).toMatchObject({ slug: 'acme-dental', planCode: 'growth' });
  });

  it('names the valid plans when given an unknown one', async () => {
    // The operator is mid-onboarding with a customer on the phone. A foreign-key violation from
    // the driver is a worse answer than a list of what they can actually pick.
    lastPlanLookup = 'enterprise';
    const { svc } = makeService();

    await expect(
      svc.create({ name: 'Acme Dental', slug: 'acme-dental', planCode: 'enterprise' }),
    ).rejects.toThrow(/base, growth, internal/);
  });

  it('returns the api key exactly once, and never the stored hash', async () => {
    lastPlanLookup = 'base';
    const { svc } = makeService();

    const created = await svc.create({ name: 'Acme Dental', slug: 'acme-dental', planCode: 'base' });

    expect(created.apiKey).toMatch(/^sk_[0-9a-f]{64}$/);
    // The hash is the stored credential. It has no business in a response body.
    expect(created).not.toHaveProperty('apiKeyHash');
    // And settings carries encrypted integration secrets on an established tenant.
    expect(created).not.toHaveProperty('settings');
    expect(JSON.stringify(created)).not.toContain('ciphertext');
  });

  it('still refuses a duplicate slug before looking at the plan', async () => {
    lastPlanLookup = 'base';
    const { svc } = makeService({ slugTaken: true });

    await expect(
      svc.create({ name: 'Acme Dental', slug: 'acme-dental', planCode: 'base' }),
    ).rejects.toThrow(/already taken/);
  });
});
