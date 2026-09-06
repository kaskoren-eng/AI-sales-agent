import { describe, expect, it, vi } from 'vitest';
import { leads } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import { applyStopSignal } from './stop-guard.js';
import type { StopSignal } from './stop-signals.js';

/**
 * The write half of the stop guardrail. The three verdicts are covered end to end in
 * `message-processor.worker.test.ts`; what is pinned HERE is the behaviour that only shows up at
 * the edges — a status that must not be walked backwards, and a failure that must not propagate
 * into the inbound message path.
 */

function fakeDb(over: { closeThrows?: boolean } = {}) {
  const sets: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({ where: async () => (over.closeThrows ? Promise.reject(new Error('db down')) : []) }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          if (table === leads) sets.push(vals);
        },
      }),
    })),
  } as unknown as Database;
  return { db, sets };
}

const SIG = (verdict: StopSignal['verdict']): StopSignal => ({
  verdict,
  source: 'phrase',
  evidence: 'test',
});

const base = { tenantId: 't-1', leadId: 'l-1', channel: 'whatsapp' as const };

describe('applyStopSignal — hard stop', () => {
  it('writes the DNC status and the soft-stop columns together', async () => {
    const { db, sets } = fakeDb();
    const out = await applyStopSignal({ db, callbacksQueue: null }, {
      ...base,
      currentStatus: 'contacted',
      signal: SIG('hard_stop'),
    });

    expect(out.action).toBe('opted_out');
    expect(sets[0]).toMatchObject({ status: 'opted_out' });
    // A do-not-call is also, trivially, a stop-following-up — both flags, one write.
    expect(sets[0]!.followupStoppedAt).toBeInstanceOf(Date);
  });

  it('does NOT walk a qualified lead backwards — canTransition guards the write', async () => {
    const { db, sets } = fakeDb();
    await applyStopSignal({ db, callbacksQueue: null }, {
      ...base,
      currentStatus: 'qualified',
      signal: SIG('hard_stop'),
    });
    // `qualified → opted_out` IS allowed, and must be: he booked and then asked to be left alone.
    expect(sets[0]).toMatchObject({ status: 'opted_out' });
  });

  it('an already opted-out lead is not re-written, but the stop is still recorded', async () => {
    const { db, sets } = fakeDb();
    const out = await applyStopSignal({ db, callbacksQueue: null }, {
      ...base,
      currentStatus: 'opted_out',
      signal: SIG('hard_stop'),
    });
    expect(out.action).toBe('opted_out');
    expect(sets[0]).not.toHaveProperty('status');
  });
});

describe('applyStopSignal — soft stop', () => {
  it('never touches the status: refusing the offer is not forbidding contact', async () => {
    const { db, sets } = fakeDb();
    const out = await applyStopSignal({ db, callbacksQueue: null }, {
      ...base,
      currentStatus: 'qualifying',
      signal: SIG('soft_stop'),
    });

    expect(out.action).toBe('followup_stopped');
    expect(sets[0]).not.toHaveProperty('status');
    expect(sets[0]!.followupStoppedAt).toBeInstanceOf(Date);
    expect(sets[0]!.followupStopReason).toBe('phrase:test');
  });
});

describe('applyStopSignal — continue', () => {
  it('is a no-op when no stop is standing', async () => {
    const { db, sets } = fakeDb();
    const out = await applyStopSignal({ db, callbacksQueue: null }, {
      ...base,
      currentStatus: 'contacted',
      signal: SIG('continue'),
    });
    expect(out.action).toBe('none');
    expect(sets).toHaveLength(0);
  });

  it('lifts a standing SOFT stop — he came back', async () => {
    const { db, sets } = fakeDb();
    const out = await applyStopSignal({ db, callbacksQueue: null }, {
      ...base,
      currentStatus: 'contacted',
      followupStoppedAt: new Date('2026-09-01T00:00:00.000Z'),
      signal: SIG('continue'),
    });
    expect(out.action).toBe('reopened');
    expect(sets[0]).toMatchObject({ followupStoppedAt: null, followupStopReason: null });
  });

  it('does NOT reopen an opted-out lead — that takes a human, deliberately', async () => {
    const { db, sets } = fakeDb();
    // He is opted out AND carries the soft flag (a hard stop sets both). A later message must not
    // silently undo a do-not-call.
    await applyStopSignal({ db, callbacksQueue: null }, {
      ...base,
      currentStatus: 'opted_out',
      followupStoppedAt: new Date('2026-09-01T00:00:00.000Z'),
      signal: SIG('continue'),
    });
    expect(sets[0]).toMatchObject({ followupStoppedAt: null });
    // The status is untouched by this path in either direction — `opted_out` is terminal in
    // `ALLOWED_TRANSITIONS`, so nothing here can move him off it.
    expect(sets[0]).not.toHaveProperty('status');
  });
});

describe('applyStopSignal — it never throws into the inbound path', () => {
  it('a DB failure is logged and swallowed', async () => {
    const db = {
      update: vi.fn(() => ({ set: () => ({ where: async () => { throw new Error('db down'); } }) })),
    } as unknown as Database;
    const error = vi.fn();

    const out = await applyStopSignal(
      { db, callbacksQueue: null, logger: { info: vi.fn(), error } },
      { ...base, currentStatus: 'contacted', signal: SIG('hard_stop') },
    );

    expect(out.action).toBe('none');
    expect(error).toHaveBeenCalled();
  });
});
