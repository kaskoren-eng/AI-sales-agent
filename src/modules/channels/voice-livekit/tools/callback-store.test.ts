import { describe, expect, it, vi } from 'vitest';
import { callbacks, leads } from '../../../../db/schema/index.js';
import { cancelCallbacksForLead, closePendingCallbacks } from './callback-store.js';

/**
 * Closing a callback that has stopped making sense.
 *
 * The rule this file exists to defend is that NOTHING HERE MAY FAIL ITS CALLER. Its four callers
 * are a booking, an opt-out, a handoff and a supersede; three of them matter more than any
 * callback row, and one of them (the opt-out) is a legal obligation. So the failure tests below
 * are not edge cases — they are the contract.
 */

interface Opts {
  pending?: Array<{ id: string; jobId: string | null; reason: string | null }>;
  failSelect?: boolean;
  failUpdate?: boolean;
}

function fakeDeps(opts: Opts = {}) {
  const callbackUpdates: Record<string, unknown>[] = [];
  const leadUpdates: Record<string, unknown>[] = [];
  const removed: string[] = [];

  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () =>
          opts.failSelect ? Promise.reject(new Error('db down')) : Promise.resolve(opts.pending ?? []),
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        if (table === callbacks) callbackUpdates.push(vals);
        if (table === leads) leadUpdates.push(vals);
        return {
          where: async () => {
            if (opts.failUpdate) throw new Error('db down');
            return undefined;
          },
        };
      },
    })),
  } as never;

  const queue = {
    remove: vi.fn(async (id: string) => {
      removed.push(id);
      return 1;
    }),
  } as never;

  return { db, queue, callbackUpdates, leadUpdates, removed };
}

const base = {
  tenantId: 'tenant-1',
  leadId: 'lead-1',
  state: 'cancelled' as const,
  note: 'cancelled:meeting_booked',
  clearLeadPointer: true,
};

describe('closePendingCallbacks', () => {
  it('moves the row out of pending, KEEPS its original reason, and unqueues the dial', async () => {
    const d = fakeDeps({
      pending: [{ id: 'cb-1', jobId: 'callback-cb-1-a0', reason: 'lead_requested:בפגישה' }],
    });
    const out = await closePendingCallbacks({ db: d.db, callbacksQueue: d.queue }, base);

    expect(out).toMatchObject({ closed: 1, jobsRemoved: 1 });
    expect(d.callbackUpdates[0]).toMatchObject({ state: 'cancelled' });
    // The original reason is WHY the callback existed; the note says why it stopped. Both survive.
    expect(String(d.callbackUpdates[0]!.reason)).toBe('lead_requested:בפגישה | cancelled:meeting_booked');
    expect(d.removed).toEqual(['callback-cb-1-a0']);
    expect(d.leadUpdates[0]).toMatchObject({ nextCallbackAt: null });
  });

  it('leaves the lead pointer alone when the caller is about to overwrite it', async () => {
    // The supersede path: the new row's due_at goes into next_callback_at moments later, and
    // clearing it first would leave a window where the lead reads "no callback" and a row disagrees.
    const d = fakeDeps({ pending: [{ id: 'cb-1', jobId: null, reason: null }] });
    await closePendingCallbacks(
      { db: d.db, callbacksQueue: d.queue },
      { ...base, state: 'superseded', clearLeadPointer: false },
    );
    expect(d.leadUpdates).toHaveLength(0);
    expect(d.callbackUpdates[0]).toMatchObject({ state: 'superseded' });
  });

  it('never touches the row the caller asked it to skip', async () => {
    const d = fakeDeps({
      pending: [
        { id: 'cb-new', jobId: null, reason: null },
        { id: 'cb-old', jobId: 'callback-cb-old-a0', reason: null },
      ],
    });
    const out = await closePendingCallbacks(
      { db: d.db, callbacksQueue: d.queue },
      { ...base, exceptId: 'cb-new' },
    );
    expect(out.closed).toBe(1);
    expect(d.removed).toEqual(['callback-cb-old-a0']);
  });

  it('does nothing at all when the lead has no pending callback — the common case', async () => {
    const d = fakeDeps({ pending: [] });
    const out = await closePendingCallbacks({ db: d.db, callbacksQueue: d.queue }, base);
    expect(out).toEqual({ closed: 0, jobsRemoved: 0 });
    expect(d.callbackUpdates).toHaveLength(0);
    expect(d.leadUpdates).toHaveLength(0);
    expect((d.queue as unknown as { remove: ReturnType<typeof vi.fn> }).remove).not.toHaveBeenCalled();
  });

  it('a row with no job id is still closed — the row is the truth, the job is a convenience', async () => {
    const d = fakeDeps({ pending: [{ id: 'cb-1', jobId: null, reason: null }] });
    const out = await closePendingCallbacks({ db: d.db, callbacksQueue: d.queue }, base);
    expect(out).toMatchObject({ closed: 1, jobsRemoved: 0 });
  });

  it('with Redis unreachable the rows are still closed — the worker re-checks state anyway', async () => {
    const d = fakeDeps({ pending: [{ id: 'cb-1', jobId: 'callback-cb-1-a0', reason: null }] });
    const out = await closePendingCallbacks({ db: d.db, callbacksQueue: null }, base);
    expect(out).toMatchObject({ closed: 1, jobsRemoved: 0 });
    expect(d.callbackUpdates[0]).toMatchObject({ state: 'cancelled' });
  });
});

describe('it never throws — every caller matters more than this does', () => {
  it('swallows a failed lookup', async () => {
    const d = fakeDeps({ failSelect: true });
    const out = await closePendingCallbacks({ db: d.db, callbacksQueue: d.queue }, base);
    expect(out.closed).toBe(0);
    expect(out.error).toContain('db down');
  });

  it('swallows a failed update — an OPT-OUT must not fail because a callbacks row would not move', async () => {
    const d = fakeDeps({ pending: [{ id: 'cb-1', jobId: null, reason: null }], failUpdate: true });
    const out = await closePendingCallbacks({ db: d.db, callbacksQueue: d.queue }, base);
    expect(out.error).toContain('db down');
  });
});

describe('cancelCallbacksForLead', () => {
  it('is a no-op without a lead id — an unattributable call has no callback to cancel', async () => {
    const d = fakeDeps({ pending: [{ id: 'cb-1', jobId: 'callback-cb-1-a0', reason: null }] });
    const rt = { tenantId: 'tenant-1', db: d.db, callbacksQueue: d.queue };
    expect(await cancelCallbacksForLead(rt, null, 'x')).toEqual({ closed: 0, jobsRemoved: 0 });
    expect(d.callbackUpdates).toHaveLength(0);
  });

  it('cancels (never supersedes) and clears the lead pointer', async () => {
    const d = fakeDeps({ pending: [{ id: 'cb-1', jobId: null, reason: null }] });
    const rt = { tenantId: 'tenant-1', db: d.db, callbacksQueue: d.queue };
    await cancelCallbacksForLead(rt, 'lead-1', 'cancelled:opted_out');
    expect(d.callbackUpdates[0]).toMatchObject({ state: 'cancelled' });
    expect(d.leadUpdates[0]).toMatchObject({ nextCallbackAt: null });
  });
});
