import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client.js';
import { tenants, plans, usageEvents, usagePeriods } from '../../db/schema/index.js';
import { recordUsageEvent, meterLead, meterCall } from './usage.service.js';

/**
 * THE METER'S TWO PROMISES.
 *
 * 1. A unit is counted AT MOST ONCE. Retried BullMQ jobs, double-delivered webhooks and a worker
 *    killed mid-write must all converge on one row. The `(tenant_id, kind, dedupe_key)` unique
 *    index is what actually enforces this; these tests pin the code's half of the bargain — that a
 *    conflict is treated as success and does NOT move the counter.
 * 2. A unit is counted AT LEAST once, or is recoverable. The metering helpers never throw, because
 *    a counter must not be able to fail a customer's lead intake or an agent's call teardown. That
 *    is only safe because the units are rebuildable from `leads` and `call_learnings` —
 *    `scripts/reconcile-usage.mjs`.
 *
 * The fake below does NOT evaluate SQL predicates — the database does that in production. What it
 * models is the one behaviour the logic actually branches on: whether an insert returned a row or
 * was swallowed by a conflict.
 */

interface FakeOptions {
  tenant?: Record<string, unknown> | null;
  plan?: Record<string, unknown> | null;
  existingPeriod?: { id: string } | null;
  /** Simulates the unique index rejecting the event — i.e. this unit was already counted. */
  eventConflicts?: boolean;
  failOn?: 'tenant' | 'event';
}

function fakeDb(opts: FakeOptions = {}) {
  const calls = {
    insertedEvents: [] as Record<string, unknown>[],
    insertedPeriods: [] as Record<string, unknown>[],
    periodUpdates: [] as Record<string, unknown>[],
  };

  const selectResult = (table: unknown) => {
    if (table === tenants) {
      if (opts.failOn === 'tenant') throw new Error('db down');
      return opts.tenant === null ? [] : [opts.tenant ?? { planCode: 'base', anchorDay: 1, includedOverride: null, overageOverride: null, priceOverride: null }];
    }
    if (table === plans) return opts.plan === null ? [] : [opts.plan ?? { monthlyPriceAgorot: 149000, includedLeads: 150, overagePerLeadAgorot: 600 }];
    if (table === usagePeriods) return opts.existingPeriod ? [opts.existingPeriod] : [];
    return [];
  };

  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: () => Promise.resolve(selectResult(table)) }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (table === usageEvents) {
              if (opts.failOn === 'event') return Promise.reject(new Error('insert exploded'));
              if (opts.eventConflicts) return Promise.resolve([]); // the index said no
              calls.insertedEvents.push(vals);
              return Promise.resolve([{ id: 'event-1' }]);
            }
            calls.insertedPeriods.push(vals);
            return Promise.resolve([{ id: 'period-1' }]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          calls.periodUpdates.push(vals);
          return Promise.resolve();
        },
      }),
    }),
  };

  const db = {
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as Database;

  return { db, calls };
}

describe('recordUsageEvent', () => {
  it('appends to the ledger and moves the counter, once', async () => {
    const { db, calls } = fakeDb();
    const result = await recordUsageEvent(db, { tenantId: 't1', kind: 'lead', dedupeKey: 'lead-1', billableUnits: 1 });

    expect(result.recorded).toBe(true);
    expect(calls.insertedEvents).toHaveLength(1);
    expect(calls.insertedEvents[0]).toMatchObject({ tenantId: 't1', kind: 'lead', dedupeKey: 'lead-1', billableUnits: 1 });
    expect(calls.periodUpdates).toHaveLength(1);
  });

  it('a repeat of the same unit is a NO-OP, not an error and not a second count', async () => {
    // THE ONE THAT PREVENTS DOUBLE-BILLING. A retried job must be silently idempotent: throwing
    // would make BullMQ retry forever, and counting would charge twice for one lead.
    const { db, calls } = fakeDb({ eventConflicts: true });
    const result = await recordUsageEvent(db, { tenantId: 't1', kind: 'lead', dedupeKey: 'lead-1', billableUnits: 1 });

    expect(result.recorded).toBe(false);
    expect(calls.insertedEvents).toHaveLength(0);
    // AND CRUCIALLY the counter did not move. A counter that advances on a conflict drifts above
    // the ledger, which bills a customer for units with no evidence behind them.
    expect(calls.periodUpdates).toHaveLength(0);
  });

  it('opens a period and FREEZES the plan values into it', async () => {
    // If a customer upgrades on the 20th, the month they are halfway through must not reprice.
    const { db, calls } = fakeDb({ existingPeriod: null });
    await recordUsageEvent(db, { tenantId: 't1', kind: 'lead', dedupeKey: 'lead-1', billableUnits: 1 });

    expect(calls.insertedPeriods).toHaveLength(1);
    expect(calls.insertedPeriods[0]).toMatchObject({
      planCode: 'base',
      monthlyPriceAgorot: 149000,
      includedLeads: 150,
      overagePerLeadAgorot: 600,
      status: 'open',
    });
  });

  it('reuses an open period instead of opening a second one', async () => {
    const { db, calls } = fakeDb({ existingPeriod: { id: 'period-existing' } });
    const result = await recordUsageEvent(db, { tenantId: 't1', kind: 'lead', dedupeKey: 'lead-2', billableUnits: 1 });

    expect(calls.insertedPeriods).toHaveLength(0);
    expect(result.periodId).toBe('period-existing');
  });

  it('a negotiated override of ZERO wins over the plan price', async () => {
    // `??` not `||`. A comped month is a real, deliberate value of 0; falling through to the
    // plan's price would quietly bill a customer who was promised a free month.
    const { db, calls } = fakeDb({
      tenant: { planCode: 'base', anchorDay: 1, includedOverride: 0, overageOverride: 0, priceOverride: 0 },
    });
    await recordUsageEvent(db, { tenantId: 't1', kind: 'lead', dedupeKey: 'lead-1', billableUnits: 1 });

    expect(calls.insertedPeriods[0]).toMatchObject({ monthlyPriceAgorot: 0, includedLeads: 0, overagePerLeadAgorot: 0 });
  });

  it('a tenant with no plan still gets metered', async () => {
    // Units accrue from day one, before anyone has been put on a tier. Refusing to meter an
    // unassigned tenant would lose exactly the trial usage that the first invoice is based on.
    const { db, calls } = fakeDb({ tenant: { planCode: null, anchorDay: 1, includedOverride: null, overageOverride: null, priceOverride: null } });
    const result = await recordUsageEvent(db, { tenantId: 't1', kind: 'lead', dedupeKey: 'lead-1', billableUnits: 1 });

    expect(result.recorded).toBe(true);
    expect(calls.insertedPeriods[0]).toMatchObject({ planCode: null, includedLeads: null });
  });

  it('call events carry cost but ZERO billable units', async () => {
    const { db, calls } = fakeDb();
    await recordUsageEvent(db, { tenantId: 't1', kind: 'call', dedupeKey: 'room-1', billableUnits: 0, costMilliAgorot: 4321 });
    expect(calls.insertedEvents[0]).toMatchObject({ kind: 'call', billableUnits: 0, costMilliAgorot: 4321 });
  });

  it('never stores a negative cost', async () => {
    const { db, calls } = fakeDb();
    await recordUsageEvent(db, { tenantId: 't1', kind: 'call', dedupeKey: 'room-1', costMilliAgorot: -999 });
    expect(calls.insertedEvents[0]!.costMilliAgorot).toBe(0);
  });

  it('throws on a database failure, so a retryable caller can retry', async () => {
    const { db } = fakeDb({ failOn: 'event' });
    await expect(recordUsageEvent(db, { tenantId: 't1', kind: 'lead', dedupeKey: 'lead-1' })).rejects.toThrow();
  });
});

describe('meterLead / meterCall never throw', () => {
  it('a metering failure does not fail lead creation', async () => {
    // A lead is the customer's core product event. Refusing to accept one because a counter is
    // unavailable trades a recoverable accounting gap for an unrecoverable business one — and the
    // gap IS recoverable, because `leads` is durable and reconciliation rebuilds from it.
    const { db } = fakeDb({ failOn: 'event' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(meterLead(db, { tenantId: 't1', leadId: 'lead-1' })).resolves.toBeUndefined();

    // But it must be LOUD. The log line is the signal that reconciliation has work to do; silence
    // here would make an under-billing bug undetectable.
    expect(spy).toHaveBeenCalledWith('usage_meter_failed', expect.stringContaining('lead-1'));
    spy.mockRestore();
  });

  it('a metering failure does not break call teardown', async () => {
    // Throwing in the agent's shutdown handler loses the call report and the call_learnings row.
    const { db } = fakeDb({ failOn: 'event' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      meterCall(db, { tenantId: 't1', roomName: 'room-1', usage: { llmPromptTokens: 100 }, durationSec: 60 }),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith('usage_meter_failed', expect.stringContaining('room-1'));
    spy.mockRestore();
  });

  it('meterLead records exactly one billable unit', async () => {
    const { db, calls } = fakeDb();
    await meterLead(db, { tenantId: 't1', leadId: 'lead-9', source: 'csv' });
    expect(calls.insertedEvents[0]).toMatchObject({ kind: 'lead', dedupeKey: 'lead-9', billableUnits: 1 });
  });

  it('meterCall prices the call and keeps the rate version with it', async () => {
    // Without the rate version a cost figure cannot be explained or re-derived after rates change.
    const { db, calls } = fakeDb();
    await meterCall(db, {
      tenantId: 't1',
      roomName: 'room-9',
      usage: { llmPromptTokens: 10_000, llmCompletionTokens: 1_000, sttAudioDurationMs: 60_000, ttsCharactersCount: 500 },
      durationSec: 60,
    });

    const event = calls.insertedEvents[0]!;
    expect(event).toMatchObject({ kind: 'call', billableUnits: 0 });
    expect(event.costMilliAgorot as number).toBeGreaterThan(0);
    expect((event.metadata as Record<string, unknown>).rateVersion).toBeTruthy();
  });

  it('an unmeasured call is recorded at zero cost rather than skipped', async () => {
    // A row saying "this call cost 0" is a visible gap in the margin data. No row at all is an
    // invisible one — and the reconciliation job would have nothing to notice.
    const { db, calls } = fakeDb();
    await meterCall(db, { tenantId: 't1', roomName: 'room-silent', usage: null });
    expect(calls.insertedEvents).toHaveLength(1);
    expect(calls.insertedEvents[0]!.costMilliAgorot).toBe(0);
  });
});
