import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { callbackJobId, cancelCallbacks, enqueueCallback } from './callbacks.queue.js';

/**
 * The job id IS the idempotency mechanism — there is deliberately no application-level dedupe on
 * top of it. So its grammar is pinned here rather than left as an implementation detail: two
 * enqueues of the same rung must collide inside BullMQ (one phone call, not two), and a
 * cancellation must be able to name the job it wants gone.
 */

describe('callbackJobId', () => {
  it('names a rung by callback id and attempt', () => {
    expect(callbackJobId('cb-1', 0)).toBe('callback-cb-1-a0');
    expect(callbackJobId('cb-1', 2)).toBe('callback-cb-1-a2');
  });

  it('is stable — the same rung always produces the same id, which is what makes it idempotent', () => {
    expect(callbackJobId('cb-1', 1)).toBe(callbackJobId('cb-1', 1));
  });

  it('a window deferral gets a FRESH id, because BullMQ will not reuse a completed one', () => {
    expect(callbackJobId('cb-1', 1, 1)).toBe('callback-cb-1-a1-d1');
    expect(callbackJobId('cb-1', 1, 2)).toBe('callback-cb-1-a1-d2');
    expect(callbackJobId('cb-1', 1, 0)).toBe('callback-cb-1-a1');
  });

  it('different attempts and different callbacks never collide', () => {
    const ids = new Set([
      callbackJobId('cb-1', 0),
      callbackJobId('cb-1', 1),
      callbackJobId('cb-1', 1, 1),
      callbackJobId('cb-2', 0),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe('enqueueCallback', () => {
  const fakeQueue = () => {
    const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
    const queue = {
      add: vi.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts });
      }),
    } as unknown as Queue;
    return { queue, added };
  };

  it('uses the deterministic id and the delay', async () => {
    const { queue, added } = fakeQueue();
    await enqueueCallback(queue, { tenantId: 't', callbackId: 'cb-1', attempt: 1, deferrals: 0 }, 90_000);
    expect(added[0]!.opts.jobId).toBe('callback-cb-1-a1');
    expect(added[0]!.opts.delay).toBe(90_000);
    expect(added[0]!.opts.attempts).toBe(3);
  });

  it('a due instant already in the past becomes delay 0, not a negative delay', async () => {
    const { queue, added } = fakeQueue();
    await enqueueCallback(queue, { tenantId: 't', callbackId: 'cb-1', attempt: 0, deferrals: 0 }, -5_000);
    expect(added[0]!.opts.delay).toBe(0);
  });

  it('carries NOTHING time-related in the job data — the row is the authority', async () => {
    const { queue, added } = fakeQueue();
    await enqueueCallback(queue, { tenantId: 't', callbackId: 'cb-1', attempt: 0, deferrals: 0 }, 1000);
    expect(added[0]!.data).toEqual({ tenantId: 't', callbackId: 'cb-1', attempt: 0, deferrals: 0 });
  });
});

describe('cancelCallbacks', () => {
  it('counts what it actually removed', async () => {
    const queue = { remove: vi.fn(async () => 1) } as unknown as Queue;
    expect(await cancelCallbacks(queue, ['a', 'b'])).toBe(2);
  });

  it('a job that already ran or never existed is NOT an error — the fire-time check is the backstop', async () => {
    const queue = {
      remove: vi.fn(async (id: string) => {
        if (id === 'boom') throw new Error('redis down');
        return id === 'live' ? 1 : 0;
      }),
    } as unknown as Queue;
    await expect(cancelCallbacks(queue, ['gone', 'boom', 'live'])).resolves.toBe(1);
  });
});
