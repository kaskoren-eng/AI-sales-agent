import { describe, expect, it, vi } from 'vitest';
import { queueLeadWrite, settleLeadWrites, type LeadWriteHost } from './lead-writes.js';

/** A promise plus the handles to settle it, so a test can hold a write open on purpose. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('queueLeadWrite', () => {
  it('returns before the write has run — that is the whole point', async () => {
    const host: LeadWriteHost = {};
    const gate = deferred();
    let ran = false;

    queueLeadWrite(host, 'capture_lead_info', async () => {
      await gate.promise;
      ran = true;
    });

    // Control is back here while the write is still open.
    expect(ran).toBe(false);
    gate.resolve();
    await settleLeadWrites(host);
    expect(ran).toBe(true);
  });

  it('runs writes IN ORDER, so two captures cannot both insert the same lead', async () => {
    const host: LeadWriteHost = {};
    const order: string[] = [];
    const first = deferred();

    queueLeadWrite(host, 'first', async () => {
      await first.promise;
      order.push('first');
    });
    queueLeadWrite(host, 'second', async () => {
      order.push('second');
    });

    // The second was queued while the first was still open; it must not have overtaken it.
    expect(order).toEqual([]);
    first.resolve();
    await settleLeadWrites(host);
    expect(order).toEqual(['first', 'second']);
  });

  it('lets the second write see what the first one resolved', async () => {
    const rt = { leadId: null as string | null } as LeadWriteHost & { leadId: string | null };
    queueLeadWrite(rt, 'first', async () => {
      rt.leadId = 'lead-1';
    });
    let seen: string | null = 'not-run';
    queueLeadWrite(rt, 'second', async () => {
      seen = rt.leadId;
    });
    await settleLeadWrites(rt);
    expect(seen).toBe('lead-1');
  });
});

describe('queueLeadWrite — failure must never reach the call', () => {
  it('swallows a rejected write, counts it, and keeps the chain usable', async () => {
    const host: LeadWriteHost = {};
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queueLeadWrite(host, 'capture_lead_info', async () => {
        throw new Error('connection terminated');
      });
      // An unhandled rejection here would take the worker down mid-call, turning a slow write
      // into a dropped call. `settleLeadWrites` must resolve, not reject.
      await expect(settleLeadWrites(host)).resolves.toBeUndefined();
      expect(host.leadWriteFailures).toBe(1);

      let laterRan = false;
      queueLeadWrite(host, 'later', async () => {
        laterRan = true;
      });
      await settleLeadWrites(host);
      expect(laterRan).toBe(true);
      expect(host.leadWriteFailures).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('records the failure on the report, because a lost fact must survive in the record', async () => {
    const recordMetric = vi.fn();
    const host: LeadWriteHost = { report: { recordMetric } };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queueLeadWrite(host, 'capture_lead_info', async () => {
        throw new Error('connection terminated');
      });
      await settleLeadWrites(host);
    } finally {
      errorSpy.mockRestore();
    }
    expect(recordMetric).toHaveBeenCalledWith('lead_write_failed', {
      kind: 'capture_lead_info',
      reason: 'connection terminated',
    });
  });

  it('survives a report that throws — a broken instrument must not break the call', async () => {
    const host: LeadWriteHost = {
      report: {
        recordMetric: () => {
          throw new Error('report exploded');
        },
      },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queueLeadWrite(host, 'capture_lead_info', async () => {
        throw new Error('connection terminated');
      });
      await expect(settleLeadWrites(host)).resolves.toBeUndefined();
      expect(host.leadWriteFailures).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('settleLeadWrites', () => {
  it('is a no-op when nothing was ever queued', async () => {
    await expect(settleLeadWrites({})).resolves.toBeUndefined();
  });
});
